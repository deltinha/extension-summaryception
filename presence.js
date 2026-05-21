/**
 * Summaryception Presence Integration Module
 *
 * Adds per-character summarization for Presence-enabled group chats.
 * Each group member gets their own memory bank, and the generate_interceptor
 * removes summarized messages from the ephemeral coreChat during prompt assembly.
 *
 * AGPL-3.0
 */

let ctx = null;
let _presenceCancelled = false;
let _presenceCatchupActive = false;

function cancelPresenceCatchup() {
    _presenceCancelled = true;
}

function isPresenceCatchupRunning() {
    return _presenceCatchupActive;
}

function isPresenceGroupMode() {
    const s = ctx.getSettings();
    if (!s.presenceGroupMemory) return false;
    const stCtx = SillyTavern.getContext();
    if (!stCtx.groupId && !stCtx.selected_group) return false;
    if (typeof globalThis.Presence === 'undefined') return false;
    return true;
}

function isOmniscientMember(avatar) {
    const { chatMetadata } = SillyTavern.getContext();
    return chatMetadata.ignore_presence?.includes(avatar) ?? false;
}

function getGroupMembers() {
    const stCtx = SillyTavern.getContext();
    const groupId = stCtx.groupId ?? stCtx.selected_group;
    if (!groupId) return [];
    const group = stCtx.groups?.find(g => g?.id === groupId);
    if (!group?.members) return [];
    return group.members
        .map(avatar => {
            const ch = stCtx.characters?.find(c => c?.avatar === avatar);
            return { avatar, name: ch?.name || avatar.replace(/\.\w+$/, '') };
        })
        .filter(m => m.avatar);
}

function getMemberStoreKey(avatar) {
    const stCtx = SillyTavern.getContext();
    const groupId = stCtx.groupId ?? stCtx.selected_group;
    return `group:${groupId}:member:${avatar}`;
}

function getMemberStore(avatar) {
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[ctx.MODULE_NAME];
    if (!root?.memories) return null;
    const key = getMemberStoreKey(avatar);
    if (!root.memories[key]) return null;
    return normalizeStore(root.memories[key]);
}

function createEmptyStore() {
    return {
        layers: [],
        summarizedUpTo: -1,
        ghostedIndices: [],
    };
}

function normalizeStore(store) {
    if (!store) return createEmptyStore();
    if (!Array.isArray(store.layers)) store.layers = [];
    if (typeof store.summarizedUpTo !== 'number') store.summarizedUpTo = -1;
    if (!Array.isArray(store.ghostedIndices)) store.ghostedIndices = [];
    return store;
}

function buildFullContextForStore(store, downToLayer = 0) {
    const parts = [];
    for (let i = store.layers.length - 1; i >= downToLayer; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            parts.push(sn.text);
        }
    }
    return parts.length > 0 ? parts.join(' ') : '(none yet)';
}

async function maybePromoteLayerForStore(store, layerIndex, charName) {
    const s = ctx.getSettings();

    if (layerIndex >= s.maxLayers - 1) {
        ctx.log(`[Presence] Max layer depth (${s.maxLayers}) reached for ${charName}.`);
        return;
    }

    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) return;

    ctx.log(`[Presence] ${charName} Layer ${layerIndex}: ${layer.length} snippets > limit ${s.snippetsPerLayer} → promoting`);

    if (!store.layers[layerIndex + 1]) store.layers[layerIndex + 1] = [];
    const destLayer = store.layers[layerIndex + 1];

    if (destLayer.length === 0) {
        const seed = layer.shift();
        seed.promoted = true;
        seed.seedFromLayer = layerIndex;
        destLayer.push(seed);
        ctx.log(`[Presence] ${charName}: Seeded Layer ${layerIndex + 1} from Layer ${layerIndex}`);
        if (layer.length > s.snippetsPerLayer) {
            await maybePromoteLayerForStore(store, layerIndex, charName);
        }
        if (destLayer.length > s.snippetsPerLayer) {
            await maybePromoteLayerForStore(store, layerIndex + 1, charName);
        }
        return;
    }

    const toMerge = layer.splice(0, s.snippetsPerPromotion);
    const storyTxt = toMerge.map(sn => sn.text).join(' ');
    const contextStr = buildFullContextForStore(store, layerIndex + 1);

    toastr.info(
        `[Presence] ${charName}: Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true }
    );

    const metaSummary = await ctx.callSummarizer(storyTxt, contextStr, charName);
    if (!metaSummary) {
        layer.unshift(...toMerge);
        return;
    }

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });

    ctx.log(`[Presence] ${charName}: Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayerForStore(store, layerIndex, charName);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayerForStore(store, layerIndex + 1, charName);
    }
}

async function summarizeForMember(memberAvatar, memberName, opts = {}) {
    const s = ctx.getSettings();
    if (!s.enabled || s.pauseSummarization) return false;
    if (ctx.isSummarizing()) return false;

    const { chat, chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[ctx.MODULE_NAME];
    if (!root) return false;
    if (!root.memories) {
        root.memories = {};
    }

    const key = getMemberStoreKey(memberAvatar);
    let store = root.memories[key];
    if (!store) {
        store = createEmptyStore();
        root.memories[key] = store;
    }
    store = normalizeStore(store);

    const charAvatar = opts.charAvatar || memberAvatar;

    const presentTurns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || !m.mes || !m.mes.trim()) continue;
        if (m.is_user) continue;
        if (i <= store.summarizedUpTo) continue;
        if (!isOmniscientMember(charAvatar)) {
            if (Array.isArray(m.present)) {
                if (!m.present.includes(charAvatar) && !m.present.includes('presence_universal_tracker')) continue;
            }
        }
        presentTurns.push({ index: i, mes: m.mes, name: m.name || memberName });
    }

    // Respect verbatimTurns: keep the last N present turns unsummarized.
    // These turns stay in-context via the interceptor, ensuring the most
    // recent N assistant responses are always available verbatim.
    const verbatimBuffer = s.verbatimTurns;
    const summarizableTurns = presentTurns.length > verbatimBuffer
        ? presentTurns.slice(0, presentTurns.length - verbatimBuffer)
        : [];

    const summarizeThreshold = s.turnsPerSummary;

    if (summarizableTurns.length < summarizeThreshold && !opts.force) {
        return false;
    }

    const batchSize = s.turnsPerSummary;
    const batch = summarizableTurns.slice(0, batchSize);
    if (batch.length === 0) return false;

    ctx.setSummarizing(true);

    try {
        const startIdx = batch[0].index;
        const endIdx = batch[batch.length - 1].index;

        if (startIdx <= store.summarizedUpTo) {
            ctx.log(`[Presence] ${memberName}: batch startIdx (${startIdx}) <= summarizedUpTo (${store.summarizedUpTo}), skipping`);
            return false;
        }

        if (!store.layers[0]) store.layers[0] = [];
        // Start right after the previous summary so user messages between
        // batches are included in the passage and turnRange display.
        const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

        if (passageStart > endIdx) {
            ctx.log(`[Presence] ${memberName}: passageStart (${passageStart}) > endIdx (${endIdx})`);
            return false;
        }

        const storyTxt = buildPresencePassage(chat, passageStart, endIdx, charAvatar);
        if (!storyTxt.trim()) return false;

        const contextStr = buildFullContextForStore(store, 0);

        toastr.info(`[Presence] Summarizing for ${memberName}: ${batch.length} turns…`, 'Summaryception', {
            timeOut: 3000,
            progressBar: true,
        });

        const summary = await ctx.callSummarizer(storyTxt, contextStr, memberName);
        if (!summary) {
            ctx.log(`[Presence] ${memberName}: summarization failed, leaving turns intact`);
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);

        await maybePromoteLayerForStore(store, 0, memberName);
        await ctx.saveChatStore();

        try {
            const stCtx = SillyTavern.getContext();
            if (stCtx.saveChat) await stCtx.saveChat();
        } catch (e) {
            ctx.log('Could not save chat:', e);
        }

        toastr.success(`[Presence] ${memberName} summary saved (Layer 0: ${store.layers[0].length} snippets)`, 'Summaryception', { timeOut: 2000 });
        return true;

    } finally {
        ctx.setSummarizing(false);
    }
}

async function maybeSummarizeForMember(memberAvatar) {
    const s = ctx.getSettings();
    if (!s.enabled || s.pauseSummarization) return;
    if (ctx.isSummarizing()) return;

    const member = getGroupMembers().find(m => m.avatar === memberAvatar);
    if (!member) return;

    const { chat } = SillyTavern.getContext();
    const store = getMemberStore(memberAvatar);
    const summarizedUpTo = store ? store.summarizedUpTo : -1;

    const presentTurns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || !m.mes || !m.mes.trim()) continue;
        if (m.is_user) continue;
        if (i <= summarizedUpTo) continue;
        if (!isOmniscientMember(memberAvatar)) {
            if (Array.isArray(m.present)) {
                if (!m.present.includes(memberAvatar) && !m.present.includes('presence_universal_tracker')) continue;
            }
        }
        presentTurns.push({ index: i, mes: m.mes, name: m.name || member.name });
    }

    // Respect verbatimTurns: only trigger when there are turns beyond the buffer.
    const summarizableCount = Math.max(0, presentTurns.length - s.verbatimTurns);
    const threshold = s.turnsPerSummary;

    if (summarizableCount >= threshold) {
        await summarizeForMember(memberAvatar, member.name);
    }
}

async function runParallelMemberCatchup(members) {
    _presenceCancelled = false;
    _presenceCatchupActive = true;

    try {
        const { chat } = SillyTavern.getContext();

        for (const member of members) {
            if (_presenceCancelled) {
                ctx.log('[Presence] Catchup cancelled by user.');
                break;
            }

            const ms = getMemberStore(member.avatar);
            const summarizedUpTo = ms ? ms.summarizedUpTo : -1;
            let presentCount = 0;
            for (let i = 0; i < chat.length; i++) {
                const m = chat[i];
                if (!m || !m.mes || !m.mes.trim()) continue;
                if (m.is_user) continue;
                if (i <= summarizedUpTo) continue;
                if (!isOmniscientMember(member.avatar)) {
                    if (Array.isArray(m.present)) {
                        if (!m.present.includes(member.avatar) && !m.present.includes('presence_universal_tracker')) continue;
                    }
                }
                presentCount++;
            }

            if (presentCount === 0) continue;

            let consecutiveFailures = 0;
            while (consecutiveFailures < 3 && !_presenceCancelled) {
                const success = await summarizeForMember(member.avatar, member.name);
                if (_presenceCancelled) break;
                if (success) {
                    consecutiveFailures = 0;
                } else {
                    consecutiveFailures++;
                    break;
                }
                await new Promise(r => setTimeout(r, 200));
            }
        }
    } finally {
        _presenceCatchupActive = false;
        _presenceCancelled = false;
    }
}

function buildPresencePassage(chat, startIdx, endIdx, charAvatar) {
    const lines = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;
        if (!m.mes || !m.mes.trim()) continue;

        // Filter both user and assistant messages by the character's presence.
        // User messages carry a present array too (set by Presence) and must be
        // filtered so a character only receives context from scenes they were in.
        if (charAvatar && Array.isArray(m.present) && !isOmniscientMember(charAvatar)) {
            if (!m.present.includes(charAvatar) && !m.present.includes('presence_universal_tracker')) {
                continue;
            }
        }

        const speaker = m.is_user ? 'Player' : 'Assistant';
        lines.push(`${speaker}: ${m.mes.trim()}`);
    }
    return lines.join('\n');
}

async function onMessageReceivedPresence(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];

    const senderAvatar = msg.force_avatar
        || (msg.name && SillyTavern.getContext().characters?.find(c => c?.name === msg.name)?.avatar)
        || null;

    const msgPresent = Array.isArray(msg.present) ? msg.present : [];

    const members = getGroupMembers();
    const membersToCheck = members.filter(m =>
        msgPresent.includes(m.avatar) || m.avatar === senderAvatar || isOmniscientMember(m.avatar)
    );

    for (const member of membersToCheck) {
        await maybeSummarizeForMember(member.avatar);
    }
}

function assembleSummaryBlockForMember(avatar) {
    const s = ctx.getSettings();
    const store = getMemberStore(avatar);
    if (!store || !store.layers || store.layers.every(l => !l || l.length === 0)) return '';
    const context = buildFullContextForStore(store);
    if (context === '(none yet)') return '';
    return s.injectionTemplate.replace('{{summary}}', context);
}

function getMembersWithStores() {
    if (!isPresenceGroupMode()) return [];
    const members = getGroupMembers();
    return members.filter(m => {
        const ms = getMemberStore(m.avatar);
        return ms && (ms.summarizedUpTo >= 0 || ms.layers.some(l => l && l.length > 0));
    });
}

function initPresence(context) {
    ctx = context;

    const { eventSource, event_types } = SillyTavern.getContext();

    let _currentDraftHandler = null;

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, async (type, config, dryRun) => {
        if (!isPresenceGroupMode() || dryRun) return;

        if (_currentDraftHandler) {
            eventSource.removeListener(event_types.GROUP_MEMBER_DRAFTED, _currentDraftHandler);
        }

        async function presenceDraftHandler(chId) {
            if (_currentDraftHandler === presenceDraftHandler) {
                _currentDraftHandler = null;
            }
            eventSource.removeListener(event_types.GROUP_MEMBER_DRAFTED, presenceDraftHandler);

            const stCtx = SillyTavern.getContext();
            const avatar = stCtx.characters[chId]?.avatar;
            if (!avatar) return;

            const groupId = stCtx.groupId ?? stCtx.selected_group;
            const root = stCtx.chatMetadata[ctx.MODULE_NAME];
            const key = `group:${groupId}:member:${avatar}`;
            const store = root?.memories?.[key];

            const s = ctx.getSettings();
            const snippets = [];
            if (store && store.layers) {
                for (let i = store.layers.length - 1; i >= 0; i--) {
                    const layer = store.layers[i];
                    if (!layer || layer.length === 0) continue;
                    for (const sn of layer) {
                        snippets.push(sn.text);
                    }
                }
            }

            if (snippets.length > 0) {
                const summaryBlock = s.injectionTemplate.replace('{{summary}}', snippets.join(' '));
                stCtx.setExtensionPrompt(ctx.MODULE_NAME, summaryBlock, 1, 9999, false, 0);
            } else {
                stCtx.setExtensionPrompt(ctx.MODULE_NAME, '', 1, 0, false, 0);
            }
        }

        _currentDraftHandler = presenceDraftHandler;
        eventSource.on(event_types.GROUP_MEMBER_DRAFTED, presenceDraftHandler);
    });

    globalThis.summaryceptionInterceptor = async function (coreChat, contextSize, abort, type) {
        if (!isPresenceGroupMode()) return;

        const stCtx = SillyTavern.getContext();
        const charName = stCtx.characters[stCtx.characterId]?.name;
        if (!charName) return;

        const members = getGroupMembers();
        const member = members.find(m => m.name === charName);
        if (!member) return;

        const groupId = stCtx.groupId ?? stCtx.selected_group;
        const root = stCtx.chatMetadata[ctx.MODULE_NAME];
        const key = `group:${groupId}:member:${member.avatar}`;
        const store = root?.memories?.[key];

        if (!store || store.summarizedUpTo < 0) return;

        const fullChat = stCtx.chat;

        const hiddenExtras = new Set();
        const limit = Math.min(store.summarizedUpTo + 1, fullChat.length);
        for (let i = 0; i < limit; i++) {
            const msg = fullChat[i];
            if (!msg) continue;
            if (msg.extra) hiddenExtras.add(msg.extra);
        }

        if (hiddenExtras.size === 0) return;

        for (let i = coreChat.length - 1; i >= 0; i--) {
            if (coreChat[i].extra && hiddenExtras.has(coreChat[i].extra)) {
                coreChat.splice(i, 1);
            }
        }
    };
}

export {
    initPresence,
    isPresenceGroupMode,
    getGroupMembers,
    getMemberStore,
    getMemberStoreKey,
    summarizeForMember,
    runParallelMemberCatchup,
    assembleSummaryBlockForMember,
    getMembersWithStores,
    cancelPresenceCatchup,
    isPresenceCatchupRunning,
    buildPresencePassage,
};
