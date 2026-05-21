/**
 * Summaryception Prompt Preview Module
 *
 * Shows the exact system + user prompt before each summarization call.
 * Supports tri-state response: Send / Abort / Dismiss (ESC).
 * Both Abort and ESC/dismiss trigger full abort (stops LLM call +
 * cancels Presence member loop).
 *
 * AGPL-3.0
 */

let _deps = null;

export function initPromptPreview(deps) {
    _deps = deps;
}

export async function showPromptPreview(systemPrompt, userPrompt) {
    const context = SillyTavern.getContext();
    const html = `
        <div class="sc-prompt-preview">
            <div class="sc-prompt-preview-section">
                <div class="sc-prompt-preview-label">System Prompt</div>
                <textarea class="text_pole sc-textarea sc-preview" rows="3" readonly data-field="system"></textarea>
            </div>
            <div class="sc-prompt-preview-section">
                <div class="sc-prompt-preview-label">User Prompt</div>
                <textarea class="text_pole sc-textarea sc-preview" rows="8" readonly data-field="user"></textarea>
            </div>
        </div>`;
    const result = await context.callGenericPopup(
        html,
        context.POPUP_TYPE.TEXT,
        '',
        {
            okButton: 'Send',
            cancelButton: 'Abort',
            allowVerticalScrolling: true,
            wide: true,
            onOpen: (popup) => {
                const systemTa = popup.dlg.querySelector('[data-field="system"]');
                const userTa = popup.dlg.querySelector('[data-field="user"]');
                if (systemTa) systemTa.value = systemPrompt;
                if (userTa) userTa.value = userPrompt;
            },
        },
    );
    if (result === context.POPUP_RESULT.AFFIRMATIVE) return 'send';
    if (result === context.POPUP_RESULT.NEGATIVE) return 'abort';
    return 'dismiss';
}

export async function maybePreviewPrompt(s, prompt) {
    if (!s.previewPrompt) return true;
    const action = await showPromptPreview(s.summarizerSystemPrompt, prompt);
    if (action !== 'send') {
        _deps.abortSummarization();
        _deps.log('Prompt preview dismissed — aborting summarization.');
        toastr.info('Summarization aborted.', 'Summaryception', { timeOut: 2000 });
        return false;
    }
    return true;
}
