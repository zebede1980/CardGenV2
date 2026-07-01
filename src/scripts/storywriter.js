/**
 * Known speaker labels for Coqui VCTK voices.
 * If a voice ID is not in this list, we fall back to a generic label.
 */
const TTS_SPEAKER_LABELS = {
    p225: 'Speaker 225',
    p226: 'Speaker 226',
    p227: 'Speaker 227',
    p228: 'Speaker 228',
    p229: 'Speaker 229',
    p230: 'Speaker 230',
    p231: 'Speaker 231',
    p232: 'Speaker 232',
    p233: 'Speaker 233',
    p234: 'Speaker 234',
    p235: 'Speaker 235',
    p236: 'Speaker 236',
    p237: 'Speaker 237',
    p238: 'Speaker 238',
    p239: 'Speaker 239',
    p240: 'Speaker 240',
    p241: 'Speaker 241',
    p242: 'Speaker 242',
    p243: 'Speaker 243',
    p244: 'Speaker 244',
    p245: 'Speaker 245',
    p246: 'Speaker 246',
    p247: 'Speaker 247',
    p248: 'Speaker 248',
    p249: 'Speaker 249',
    p250: 'Speaker 250',
    p251: 'Speaker 251',
    p252: 'Speaker 252',
    p253: 'Speaker 253',
    p254: 'Speaker 254',
    p255: 'Speaker 255',
    p256: 'Speaker 256',
    p257: 'Speaker 257',
    p258: 'Speaker 258',
    p259: 'Speaker 259',
    p260: 'Speaker 260',
    p261: 'Speaker 261',
    p262: 'Speaker 262',
    p263: 'Speaker 263',
    p264: 'Speaker 264',
    p265: 'Speaker 265',
    p266: 'Speaker 266',
    p267: 'Speaker 267',
    p268: 'Speaker 268',
    p269: 'Speaker 269',
    p270: 'Speaker 270',
    p271: 'Speaker 271',
    p272: 'Speaker 272',
};

function formatSpeakerLabel(speakerId) {
    if (typeof speakerId !== 'string') {
        return String(speakerId);
    }
    const label = TTS_SPEAKER_LABELS[speakerId];
    if (label) {
        return `${speakerId} — ${label}`;
    }
    const match = speakerId.match(/^p(\d+)$/i);
    if (match) {
        return `${speakerId} — Speaker ${match[1]}`;
    }
    if (speakerId.includes('Neural2') || speakerId.includes('Wavenet') || speakerId.includes('Standard')) {
        return speakerId.replace(/-/g, ' ');
    }
    return speakerId;
}

/**
 * TTSPlayer — Manages the Web Audio API pipeline for sequential sentence playback.
 * Uses a GainNode for volume control and queues sentences fetched from the TTS bridge.
 */
class TTSPlayer {
    constructor() {
        this.audioElement = new Audio();
        // Unlock audio element on iOS immediately during instantiation (which happens in a click handler)
        this.audioElement.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        this.audioElement.play().catch(() => {});
        
        this.audioElement.onended = () => {
            if (!this.stopped && !this.paused) {
                this._playNext();
            }
        };
        this._setupMediaSession();
        
        this.currentUrl = null;
        this.textQueue = [];
        this.audioQueue = [];
        this.playing = false;
        this.paused = false;
        this.stopped = false;
        this.loading = false;
        this.onQueueLow = null;
        this._queueLowFired = false;
        this.onQueueEmpty = null;   // callback when all queued audio finishes naturally
        this.onError = null;        // callback for synthesis errors
        this.voice = 'p230';
        this.speed = 1.0;
        this.provider = 'local';
        this.googleApiKey = '';
        this.nanogptKey = '';
        this.nanogptModel = '';
        this.nanogptVoice = '';
        this.errorCount = 0;
    }

    _setupMediaSession() {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', () => this.resume());
            navigator.mediaSession.setActionHandler('pause', () => this.pause());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.skip());
            navigator.mediaSession.setActionHandler('stop', () => this.stop());
        }
    }

    _updateMediaMetadata(text) {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: text || 'Story Narration',
                artist: 'SillyTavern Story Writer',
                album: 'Character Generator V2',
            });
        }
    }

    /**
     * Set volume 0-100, mapped to gain 0-1.
     */
    setVolume(vol) {
        const gain = Math.max(0, Math.min(1, vol / 100));
        this.audioElement.volume = gain;
    }

    /**
     * Add a sentence to the playback queue. Kicks off buffering and playback.
     */
    enqueue(text, voiceOverride = null) {
        if (!text || !text.trim()) return;
        
        // Clean up markdown and special characters that TTS struggles with
        let cleaned = text;
        // Remove markdown headings
        cleaned = cleaned.replace(/^[#]+\s*/g, '');
        // Remove markdown list bullets
        cleaned = cleaned.replace(/^\s*[-*+]\s+/g, '');
        // Remove formatting characters (bold, italics, strikethrough, code)
        cleaned = cleaned.replace(/[*_~`]/g, '');
        // Replace standalone dashes with a comma to preserve a natural pause
        cleaned = cleaned.replace(/\s+[-—]+\s+/g, ', ');

        const trimmed = cleaned.trim();
        if (!trimmed) return;

        console.debug('[TTSPlayer] Enqueue sentence', trimmed, voiceOverride ? `(Voice: ${voiceOverride})` : '');
        this.textQueue.push({text: trimmed, voiceOverride});
        this._queueLowFired = false;
        this._maybeLoadNext();
        if (!this.playing && !this.paused && this.audioQueue.length > 0) {
            this._playNext();
        }
    }

    async _maybeLoadNext() {
        if (this.stopped || this.paused || this.loading || this.textQueue.length === 0) {
            if (this.textQueue.length === 0 && !this.loading && !this._queueLowFired && !this.stopped) {
                this._queueLowFired = true;
                if (this.onQueueLow) this.onQueueLow();
            }
            return;
        }

        // Keep multiple chunks buffered ahead.
        if (this.audioQueue.length >= 4) {
            return;
        }

        this.loading = true;
        const queueItem = this.textQueue.shift();
        const text = queueItem.text;
        const voiceOverride = queueItem.voiceOverride;
        
        if (this.textQueue.length === 0 && !this._queueLowFired && !this.stopped) {
            this._queueLowFired = true;
            if (this.onQueueLow) this.onQueueLow();
        }
        console.debug('[TTSPlayer] Loading audio for sentence', text);
        try {
            const res = await window.authFetch('/api/tts/synthesize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice: voiceOverride || this.voice, speed: this.speed, provider: this.provider, googleApiKey: this.googleApiKey, nanogptKey: this.nanogptKey, nanogptModel: this.nanogptModel, nanogptVoice: this.nanogptVoice }),
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                console.warn('[TTSPlayer] Synthesis HTTP', res.status, errText, '— skipping sentence');
                this.errorCount++;
                if (this.onError) this.onError(`HTTP ${res.status}: ${errText || 'Failed'}`);
                
                if (this.errorCount >= 3) {
                    console.error('[TTSPlayer] Halting after 3 consecutive failures to prevent runaway billing.');
                    if (this.onError) this.onError(`Halting playback: 3 consecutive errors encountered.`);
                    this.stop();
                    return;
                }
            } else {
                this.errorCount = 0;
                const blob = await res.blob();
                if (blob.size > 0) {
                    const url = URL.createObjectURL(blob);
                    this.audioQueue.push({ url, text });
                    console.debug('[TTSPlayer] Audio buffered', { queueLength: this.audioQueue.length });
                    if (!this.playing && !this.paused) {
                        this._playNext();
                    }
                }
            }
        } catch (e) {
            console.error('[TTSPlayer] Audio load error:', e);
            this.errorCount++;
            if (this.onError) this.onError(`Network error: ${e.message}`);
            
            if (this.errorCount >= 3) {
                console.error('[TTSPlayer] Halting after 3 consecutive network failures.');
                if (this.onError) this.onError(`Halting playback: 3 consecutive network errors.`);
                this.stop();
                return;
            }
        } finally {
            this.loading = false;
            if (!this.stopped && !this.paused) {
                if (this.textQueue.length > 0 && this.audioQueue.length < 4) {
                    this._maybeLoadNext();
                } else if (!this.playing && this.audioQueue.length === 0) {
                    this._playNext();
                }
            }
        }
    }

    async _playNext() {
        if (this.stopped) {
            this.playing = false;
            return;
        }

        if (this.paused) {
            return;
        }

        if (this.audioQueue.length === 0) {
            if (this.textQueue.length > 0) {
                this._maybeLoadNext();
            }
            this.playing = false;
            if (this.onQueueEmpty && this.textQueue.length === 0 && this.audioQueue.length === 0) {
                this.onQueueEmpty();
            }
            return;
        }

        const audioItem = this.audioQueue.shift();
        this.playing = true;

        if (this.currentUrl) {
            URL.revokeObjectURL(this.currentUrl);
        }
        
        this.currentUrl = audioItem.url;
        this.audioElement.src = audioItem.url;
        this._updateMediaMetadata(audioItem.text);

        try {
            await this.audioElement.play();
            console.debug('[TTSPlayer] Started playback for:', audioItem.text);
        } catch (e) {
            console.error('[TTSPlayer] Playback failed (autoplay blocked?):', e);
            this.playing = false;
        }

        // Continue buffering while current audio plays.
        this._maybeLoadNext();
    }

    pause() {
        this.paused = true;
        this.audioElement.pause();
    }

    resume() {
        this.paused = false;
        if (!this.playing && this.currentUrl) {
            this.playing = true;
            this.audioElement.play().catch(e => console.error('[TTSPlayer] Resume failed:', e));
            this._maybeLoadNext();
        } else if (!this.playing) {
            this._playNext();
        } else {
            this.audioElement.play().catch(e => console.error(e));
        }
    }

    skip() {
        this.audioElement.pause();
        this._playNext();
    }

    stop() {
        console.debug('[TTSPlayer] stop');
        this.stopped = true;
        this.onQueueLow = null;
        this._queueLowFired = false;
        this.paused = false;
        
        this.audioElement.pause();
        this.audioElement.src = '';
        if (this.currentUrl) {
            URL.revokeObjectURL(this.currentUrl);
            this.currentUrl = null;
        }
        
        this.textQueue = [];
        this.audioQueue.forEach(item => URL.revokeObjectURL(item.url));
        this.audioQueue = [];
        this.loading = false;
        this.playing = false;
    }

    reset() {
        this.stop();
        this.stopped = false;
    }
}

/**
 * SentenceDetector — Accumulates text chunks from the LLM stream and yields
 * complete sentences as they are recognised (sentence-ending punctuation).
 */
class SentenceDetector {
    constructor() {
        this.buffer = '';
    }

    /**
     * Feed a chunk of text. Returns an array of complete paragraphs found.
     * Incomplete trailing text stays in the internal buffer.
     */
    feed(chunk) {
        this.buffer += chunk;
        const paragraphs = [];
        
        // Split by one or more newlines
        const lines = this.buffer.split(/\n+/);
        
        // If there's more than 1 item, everything except the last is a complete paragraph
        if (lines.length > 1) {
            for (let i = 0; i < lines.length - 1; i++) {
                if (lines[i].trim()) {
                    paragraphs.push(lines[i].trim());
                }
            }
            this.buffer = lines[lines.length - 1];
        }
        
        return paragraphs;
    }

    /**
     * Return whatever remains in the buffer as a final sentence.
     */
    flush() {
        const remainder = this.buffer.trim();
        this.buffer = '';
        return remainder ? [remainder] : [];
    }
}

class StoryWriterApp {
    constructor() {
        this.currentStoryId = null;
        this.story = null;
        this.allCards = [];
        this.isFetchingLLM = false;
        this.ttsPlayer = null;       // Active TTSPlayer instance (null when TTS disabled)
        this.ttsSettings = {};       // Cached TTS settings from backend
        this.currentPlayingSegmentId = null; // Track which segment is currently playing
        this.abortController = null; // Used to abort LLM generation fetches

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.bindEvents());
        } else {
            this.bindEvents();
        }
    }

    bindEvents() {
        const tabCardGen = document.getElementById('tab-cardgen');
        const tabStoryWriter = document.getElementById('tab-storywriter');
        const viewCardGen = document.getElementById('view-cardgen');
        const viewStoryWriter = document.getElementById('view-storywriter');

        if (tabCardGen && tabStoryWriter) {
            tabCardGen.addEventListener('click', () => {
                viewCardGen.style.display = 'block';
                viewStoryWriter.style.display = 'none';
                tabCardGen.className = 'btn-primary';
                tabStoryWriter.className = 'btn-outline';
            });

            tabStoryWriter.addEventListener('click', async () => {
                viewCardGen.style.display = 'none';
                viewStoryWriter.style.display = 'block';
                tabCardGen.className = 'btn-outline';
                tabStoryWriter.className = 'btn-primary';
                await this.loadSettings();
                this.loadStories();
                this.loadVoices();
            });
        }

        document.getElementById('sw-create-btn')?.addEventListener('click', () => this.createStory());
        document.getElementById('sw-back-btn')?.addEventListener('click', () => {
            document.getElementById('sw-list-view').style.display = 'block';
            document.getElementById('sw-workspace-view').style.display = 'none';
            this.currentStoryId = null;
            this.loadStories();
            // Stop any active TTS when leaving workspace
            if (this.ttsPlayer) {
                this.ttsPlayer.stop();
                this._hideNarrationControls();
            }
        });

        const titleInput = document.getElementById('sw-title');
        if (titleInput) {
            titleInput.addEventListener('change', (e) => this.updateStory(e.target.value, this.story.synopsis));
        }

        const synopsisInput = document.getElementById('sw-synopsis');
        if (synopsisInput) {
            synopsisInput.addEventListener('change', (e) => this.updateStory(this.story.title, e.target.value));
        }

        const addCardSelect = document.getElementById('sw-add-card-select');
        if (addCardSelect) {
            addCardSelect.addEventListener('change', (e) => {
                if (e.target.value) {
                    this.attachCard(parseInt(e.target.value));
                    e.target.value = "";
                }
            });
        }

        document.getElementById('sw-generate-btn')?.addEventListener('click', () => this.generateNext());
        document.getElementById('sw-stop-btn')?.addEventListener('click', () => this.stopGeneration());
        document.getElementById('sw-save-settings-btn')?.addEventListener('click', () => this.saveSettings());

        // ── TTS playback control bindings ──────────────────────────────────────
        document.getElementById('sw-tts-pause-btn')?.addEventListener('click', () => this._togglePause());
        document.getElementById('sw-tts-skip-btn')?.addEventListener('click', () => {
            if (this.ttsPlayer) this.ttsPlayer.skip();
        });
        document.getElementById('sw-tts-stop-btn')?.addEventListener('click', () => this._stopNarration());
        document.getElementById('sw-tts-test-btn')?.addEventListener('click', () => this.testVoiceSample());

        // ── TTS settings UI reactivity ─────────────────────────────────────────
        const speedSlider = document.getElementById('sw-tts-speed');
        if (speedSlider) {
            speedSlider.addEventListener('input', () => {
                document.getElementById('sw-tts-speed-label').textContent = speedSlider.value + 'x';
            });
        }

        const ttsEnabled = document.getElementById('sw-tts-enabled');
        const autoMode = document.getElementById('sw-auto-mode');
        if (ttsEnabled && autoMode) {
            ttsEnabled.addEventListener('change', () => {
                // If TTS is disabled, auto-disable auto-mode
                if (!ttsEnabled.checked) {
                    autoMode.checked = false;
                }
            });
        }

        const providerSelect = document.getElementById('sw-tts-provider');
        if (providerSelect) {
            providerSelect.addEventListener('change', () => {
                const provider = providerSelect.value;
                document.getElementById('sw-tts-google-key-container').style.display = provider.startsWith('google') ? 'block' : 'none';
                
                const nanogptContainer = document.getElementById('sw-tts-nanogpt-container');
                if (nanogptContainer) nanogptContainer.style.display = provider === 'nanogpt' ? 'block' : 'none';
                
                const standardVoiceContainer = document.getElementById('sw-tts-standard-voice-container');
                if (standardVoiceContainer) standardVoiceContainer.style.display = provider === 'nanogpt' ? 'none' : 'block';
                
                this.loadVoices();
            });
        }
        document.getElementById('sw-tts-google-key')?.addEventListener('change', () => this.loadVoices());

        // ── Phone-lock / tab-switch resilience ────────────────────────────────
        document.addEventListener('visibilitychange', () => this.syncOnWake());
        window.addEventListener('focus', () => this.syncOnWake());
    }

    /**
     * Fires whenever the document becomes visible again (phone unlock, tab switch, app resume).
     *
     * Two behaviours depending on state:
     *   1. Actively generating  — poll the server to see if it finished while the client was
     *      asleep.  If so, abort the stale stream (triggering the catch path which calls
     *      refreshWorkspace) so the UI snaps back to the saved result seamlessly.
     *   2. Idle with story open — silently refresh the workspace so that changes made on
     *      another device (e.g. desktop) appear automatically.
     */
    async syncOnWake() {
        if (document.visibilityState !== 'visible') return;
        if (!this.currentStoryId) return;

        if (this.isFetchingLLM) {
            // ── Mid-generation recovery ──────────────────────────────────────
            try {
                const story = await this.apiCall(`/stories/${this.currentStoryId}`);
                const domCount = document.querySelectorAll('#sw-story-area [data-segment-id]').length;
                const dbCount  = (story.segments || []).filter(s => !s.is_summary).length;

                if (dbCount > domCount) {
                    // Server completed generation while the client was asleep.
                    // Set flag so the catch block in generateNext knows this is a wake-recovery
                    // abort (not a user stop) and should call refreshWorkspace().
                    this._wakeAbort = true;
                    if (this.abortController) this.abortController.abort();
                } else {
                    // Server is still generating (no new segment yet).
                    // Ensure the UI clearly reflects the in-progress state in case
                    // the phone lock reset button labels.
                    const btn = document.getElementById('sw-generate-btn');
                    const stopBtn = document.getElementById('sw-stop-btn');
                    if (btn) { btn.textContent = 'Generating...'; btn.disabled = true; }
                    if (stopBtn) stopBtn.style.display = 'inline-block';
                }
            } catch (e) {
                console.error('[StoryWriter] syncOnWake (generating) failed:', e);
            }
        } else {
            // ── Idle cross-device sync ───────────────────────────────────────
            try {
                await this.refreshWorkspace();
            } catch (e) {
                console.error('[StoryWriter] syncOnWake (idle) failed:', e);
            }
        }
    }

    // ── API helper ────────────────────────────────────────────────────────────

    async apiCall(path, method = 'GET', body = null) {
        const url = `/api/sw${path}`;
        const options = { method, headers: {} };
        if (body) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const res = await window.authFetch(url, options);
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    }

    // ── Settings ──────────────────────────────────────────────────────────────



    async loadSettings() {
        try {
            const s = await this.apiCall('/settings/');
            document.getElementById('sw-max-tokens').value = s.max_tokens ?? 2048;
            document.getElementById('sw-temperature').value = s.temperature ?? 0.8;
            document.getElementById('sw-context-window').value = s.context_window ?? 8000;
            document.getElementById('sw-system-prompt').value = s.system_prompt || '';

            // Populate image model dropdown from CardGen config
            const select = document.getElementById('sw-image-model');
            if (select) {
                const models = window.configManager?.config?.api?.image?.models || [];
                select.innerHTML = '<option value="">\u2014 Use CardGen active model \u2014</option>';
                models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m;
                    opt.textContent = m;
                    select.appendChild(opt);
                });
                select.value = s.image_model || '';
            }

            // ── TTS settings ───────────────────────────────────────────────────
            let savedProvider = window.config.get('api.tts.provider') || localStorage.getItem('sw-tts-provider') || 'local';
            if (savedProvider === 'google') savedProvider = 'google-premium';
            const savedGoogleKey = window.config.get('api.tts.apiKey') || localStorage.getItem('sw-tts-google-key') || '';
            const savedNanogptKey = window.config.get('api.tts.nanogptKey') || localStorage.getItem('sw-tts-nanogpt-key') || '';
            const savedNanogptModel = window.config.get('api.tts.nanogptModel') || localStorage.getItem('sw-tts-nanogpt-model') || '';
            const savedNanogptVoice = window.config.get('api.tts.nanogptVoice') || localStorage.getItem('sw-tts-nanogpt-voice') || '';

            this.ttsSettings = {
                tts_enabled: s.tts_enabled || false,
                auto_mode: s.auto_mode || false,
                tts_voice: s.tts_voice || 'p230',
                tts_speed: s.tts_speed || 1.0,
                tts_provider: savedProvider,
                tts_google_key: savedGoogleKey,
                tts_nanogpt_key: savedNanogptKey,
                tts_nanogpt_model: savedNanogptModel,
                tts_nanogpt_voice: savedNanogptVoice
            };
            console.debug('[StoryWriter][TTS] Loaded settings', this.ttsSettings);

            const ttsEnabled = document.getElementById('sw-tts-enabled');
            const autoMode = document.getElementById('sw-auto-mode');
            const scriptMode = document.getElementById('sw-script-mode');
            const voiceSelect  = document.getElementById('sw-tts-voice');
            const speedSlider  = document.getElementById('sw-tts-speed');
            const speedLabel   = document.getElementById('sw-tts-speed-label');
            const providerSelect = document.getElementById('sw-tts-provider');
            const googleKeyInput = document.getElementById('sw-tts-google-key');
            const nanogptKeyInput = document.getElementById('sw-tts-nanogpt-key');
            const nanogptModelSelect = document.getElementById('sw-tts-nanogpt-model');
            const nanogptVoiceInput = document.getElementById('sw-tts-nanogpt-voice');

            if (ttsEnabled) ttsEnabled.checked = this.ttsSettings.tts_enabled;
            if (autoMode)  autoMode.checked  = this.ttsSettings.auto_mode;
            if (scriptMode) scriptMode.checked = window.config.get('api.tts.scriptMode') || false;
            if (speedSlider) {
                speedSlider.value = this.ttsSettings.tts_speed;
                if (speedLabel) speedLabel.textContent = this.ttsSettings.tts_speed + 'x';
            }
            if (providerSelect) {
                providerSelect.value = this.ttsSettings.tts_provider;
                document.getElementById('sw-tts-google-key-container').style.display = this.ttsSettings.tts_provider.startsWith('google') ? 'block' : 'none';
                
                const nanogptContainer = document.getElementById('sw-tts-nanogpt-container');
                if (nanogptContainer) nanogptContainer.style.display = this.ttsSettings.tts_provider === 'nanogpt' ? 'block' : 'none';
                
                const standardVoiceContainer = document.getElementById('sw-tts-standard-voice-container');
                if (standardVoiceContainer) standardVoiceContainer.style.display = this.ttsSettings.tts_provider === 'nanogpt' ? 'none' : 'block';
            }
            if (googleKeyInput) {
                googleKeyInput.value = this.ttsSettings.tts_google_key;
            }
            if (nanogptKeyInput) {
                nanogptKeyInput.value = this.ttsSettings.tts_nanogpt_key;
            }
            if (nanogptModelSelect) {
                nanogptModelSelect.value = this.ttsSettings.tts_nanogpt_model;
            }
            if (nanogptVoiceInput) {
                nanogptVoiceInput.value = this.ttsSettings.tts_nanogpt_voice;
            }
        } catch (e) {
            console.error('[StoryWriter] Failed to load settings:', e);
        }
    }

    async saveSettings() {
        const btn = document.getElementById('sw-save-settings-btn');
        const status = document.getElementById('sw-settings-status');

        const maxTokens = parseInt(document.getElementById('sw-max-tokens').value, 10);
        const temperature = parseFloat(document.getElementById('sw-temperature').value);
        const contextWindow = parseInt(document.getElementById('sw-context-window').value, 10);
        const systemPrompt = document.getElementById('sw-system-prompt').value.trim();
        const imageModel = (document.getElementById('sw-image-model')?.value || '').trim();

        if (isNaN(maxTokens) || isNaN(temperature) || isNaN(contextWindow)) {
            status.textContent = 'Max Tokens, Temperature and Context Window must be valid numbers.';
            status.style.color = 'var(--error-color, #e55)';
            return;
        }

        const ttsEnabled = document.getElementById('sw-tts-enabled')?.checked || false;
        const autoMode   = document.getElementById('sw-auto-mode')?.checked || false;
        const scriptMode = document.getElementById('sw-script-mode')?.checked || false;
        const ttsVoice   = document.getElementById('sw-tts-voice')?.value || 'p230';
        const ttsSpeed   = parseFloat(document.getElementById('sw-tts-speed')?.value || '1.0');
        const ttsProvider = document.getElementById('sw-tts-provider')?.value || 'local';
        const ttsGoogleKey = document.getElementById('sw-tts-google-key')?.value || '';
        const ttsNanogptKey = document.getElementById('sw-tts-nanogpt-key')?.value || '';
        const ttsNanogptModel = document.getElementById('sw-tts-nanogpt-model')?.value || '';
        const ttsNanogptVoice = document.getElementById('sw-tts-nanogpt-voice')?.value || '';

        if (window.config) {
            window.config.set('api.tts.provider', ttsProvider);
            window.config.set('api.tts.apiKey', ttsGoogleKey);
            window.config.set('api.tts.nanogptKey', ttsNanogptKey);
            window.config.set('api.tts.nanogptModel', ttsNanogptModel);
            window.config.set('api.tts.nanogptVoice', ttsNanogptVoice);
            window.config.set('api.tts.scriptMode', scriptMode);
        }
        localStorage.removeItem('sw-tts-provider');
        localStorage.removeItem('sw-tts-google-key');
        localStorage.removeItem('sw-tts-nanogpt-key');
        localStorage.removeItem('sw-tts-nanogpt-model');
        localStorage.removeItem('sw-tts-nanogpt-voice');

        const payload = {
            max_tokens: maxTokens,
            temperature,
            context_window: contextWindow,
            system_prompt: systemPrompt,
            image_model: imageModel,
            tts_enabled: ttsEnabled,
            auto_mode: autoMode,
            tts_voice: ttsVoice,
            tts_speed: ttsSpeed,
        };

        // Update local cache
        this.ttsSettings = {
            tts_enabled: ttsEnabled,
            auto_mode: autoMode,
            tts_voice: ttsVoice,
            tts_speed: ttsSpeed,
            tts_provider: ttsProvider,
            tts_google_key: ttsGoogleKey,
            tts_nanogpt_key: ttsNanogptKey,
            tts_nanogpt_model: ttsNanogptModel,
            tts_nanogpt_voice: ttsNanogptVoice
        };

        btn.disabled = true;
        status.textContent = 'Saving\u2026';
        status.style.color = 'var(--text-secondary)';
        try {
            await window.authFetch('/api/sw/settings/', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            status.textContent = 'Saved!';
            status.style.color = 'var(--success-color, #5c5)';
            setTimeout(() => { status.textContent = ''; }, 3000);
        } catch (e) {
            status.textContent = 'Save failed: ' + e.message;
            status.style.color = 'var(--error-color, #e55)';
        } finally {
            btn.disabled = false;
        }
    }

    // ── TTS Voice loading ─────────────────────────────────────────────────────

    async loadVoices() {
        const voiceSelect = document.getElementById('sw-tts-voice');
        const statusSpan  = document.getElementById('sw-tts-status');
        const provider = document.getElementById('sw-tts-provider')?.value || 'kokoro';
        const googleKey = document.getElementById('sw-tts-google-key')?.value || '';

        if (!voiceSelect) return;

        try {
            let res;
            if (provider === 'nanogpt') {
                // Nano-GPT models and voices are now handled purely by datalist inputs in the UI,
                // so we don't dynamically fetch them anymore to avoid errors with endpoints that don't exist.
                return;
            } else if (provider.startsWith('google')) {
                if (!googleKey) {
                    voiceSelect.innerHTML = '<option value="">— Enter API Key —</option>';
                    if (statusSpan) statusSpan.textContent = 'Key required';
                    return;
                }
                const tier = provider === 'google-standard' ? 'standard' : 'premium';
                res = await window.authFetch(`/api/tts/google-voices?key=${googleKey}&tier=${tier}`);
            } else {
                res = await window.authFetch('/api/tts/voices?provider=' + encodeURIComponent(provider));
            }
            const data = await res.json();
            console.debug('[StoryWriter][TTS] Voice endpoint response', data);

            if (data.status === 'loading') {
                voiceSelect.innerHTML = '<option value="">\u2014 Model loading\u2026 \u2014</option>';
                if (statusSpan) statusSpan.textContent = '\u23f3 Loading TTS model\u2026';
                // Poll until ready
                setTimeout(() => this.loadVoices(), 3000);
                return;
            }

            if (data.status === 'error') {
                voiceSelect.innerHTML = '<option value="">\u2014 TTS unavailable \u2014</option>';
                if (statusSpan) statusSpan.textContent = '\u26a0\ufe0f ' + (data.error || 'TTS not available');
                return;
            }

            const speakers = data.speakers || [];
            voiceSelect.innerHTML = '';
            if (speakers.length === 0) {
                voiceSelect.innerHTML = '<option value="">\u2014 No voices found \u2014</option>';
                if (statusSpan) statusSpan.textContent = '';
                return;
            }

            speakers.forEach(speaker => {
                const opt = document.createElement('option');
                opt.value = speaker;
                opt.textContent = formatSpeakerLabel(speaker);
                voiceSelect.appendChild(opt);
            });

            // Restore saved voice
            if (this.ttsSettings.tts_voice && speakers.includes(this.ttsSettings.tts_voice)) {
                voiceSelect.value = this.ttsSettings.tts_voice;
            } else if (speakers.length > 0) {
                voiceSelect.value = speakers[0];
            }

            if (statusSpan) statusSpan.textContent = speakers.length + ' voices available';
            console.debug('[StoryWriter][TTS] Loaded voices', speakers);
            if (this.currentStoryId) this.renderCards();
        } catch (e) {
            console.error('[StoryWriter] Failed to load TTS voices:', e);
            voiceSelect.innerHTML = '<option value="">\u2014 TTS unreachable \u2014</option>';
            const statusSpan = document.getElementById('sw-tts-status');
            if (statusSpan) statusSpan.textContent = '\u26a0\ufe0f TTS service not reachable';
        }
    }

    async testVoiceSample() {
        const testBtn = document.getElementById('sw-tts-test-btn');
        const testStatus = document.getElementById('sw-tts-test-status');
        const voiceSelect = document.getElementById('sw-tts-voice');
        const speedSlider = document.getElementById('sw-tts-speed');
        const volumeSlider = document.getElementById('sw-tts-volume');
        const originalStatus = testStatus?.textContent || '';

        if (!voiceSelect) return;
        const voice = voiceSelect.value;
        if (!voice) {
            if (testStatus) testStatus.textContent = 'Please select a voice first.';
            return;
        }

        if (this.ttsPlayer) {
            this._stopNarration();
        }

        if (testBtn) {
            testBtn.disabled = true;
            testBtn.textContent = 'Testing…';
        }
        if (testStatus) {
            testStatus.textContent = 'Playing sample…';
        }

        const player = new TTSPlayer();
        player.voice = voice;
        player.speed = parseFloat(speedSlider?.value || '1.0');
        player.setVolume(parseInt(volumeSlider?.value || '80', 10));
        player.provider = document.getElementById('sw-tts-provider')?.value || 'local';
        player.googleApiKey = document.getElementById('sw-tts-google-key')?.value || '';
        player.nanogptKey = document.getElementById('sw-tts-nanogpt-key')?.value || '';
        player.nanogptModel = document.getElementById('sw-tts-nanogpt-model')?.value || '';
        player.nanogptVoice = document.getElementById('sw-tts-nanogpt-voice')?.value || '';

        let hasError = false;
        player.onError = (err) => {
            hasError = true;
            if (testStatus) {
                testStatus.textContent = `❌ ${err}`;
                testStatus.style.color = 'var(--error-color, #e55)';
            }
        };

        player.onQueueEmpty = () => {
            if (testStatus && !hasError) {
                testStatus.textContent = 'Sample complete.';
            }
            if (testBtn) {
                testBtn.textContent = 'Test Voice';
                testBtn.disabled = false;
            }
            setTimeout(() => {
                if (testStatus && (testStatus.textContent === 'Sample complete.' || hasError)) {
                    testStatus.textContent = originalStatus;
                    testStatus.style.color = '';
                }
            }, 3500);
        };

        player.enqueue('This is a sample of the selected voice.');
    }

    // ── Story management ──────────────────────────────────────────────────────

    async loadStories() {
        try {
            const stories = await this.apiCall('/stories/');
            const list = document.getElementById('sw-story-list');
            list.innerHTML = '';

            if (stories.length === 0) {
                list.innerHTML = '<p style="color: var(--text-secondary);">No stories yet. Create one above!</p>';
                return;
            }

            stories.forEach(story => {
                const card = document.createElement('div');
                card.className = 'content-box';
                card.style.cursor = 'pointer';
                card.style.position = 'relative';
                card.innerHTML = `
                    <h3 style="margin-top: 0; margin-bottom: 0.5rem; padding-right: 2.5rem;">${story.title}</h3>
                    <p style="font-size: 0.85rem; color: var(--text-secondary);">Updated: ${new Date(story.updated_at).toLocaleDateString()}</p>
                `;

                const delBtn = document.createElement('button');
                delBtn.textContent = '\ud83d\uddd1';
                delBtn.title = 'Delete story';
                delBtn.style.cssText = 'position:absolute; top:0.6rem; right:0.6rem; background:none; border:1px solid transparent; border-radius:4px; cursor:pointer; font-size:1rem; color:var(--error-color,#e55); opacity:0.55; padding:0.2rem 0.35rem; line-height:1;';
                delBtn.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; delBtn.style.borderColor = 'var(--error-color,#e55)'; delBtn.style.background = 'rgba(220,50,50,0.1)'; });
                delBtn.addEventListener('mouseleave', () => { delBtn.style.opacity = '0.55'; delBtn.style.borderColor = 'transparent'; delBtn.style.background = 'none'; });
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete "${story.title}"? This cannot be undone.`)) return;
                    try {
                        await this.apiCall(`/stories/${story.id}`, 'DELETE');
                        await this.loadStories();
                    } catch (err) {
                        alert('Failed to delete story: ' + err.message);
                    }
                });

                card.addEventListener('click', () => this.openStory(story.id));
                card.appendChild(delBtn);
                list.appendChild(card);
            });
        } catch (e) { console.error("Failed to load stories", e); }
    }

    async createStory() {
        const title = document.getElementById('sw-new-title').value.trim();
        if (!title) return alert("Enter a title");
        try {
            const story = await this.apiCall('/stories/', 'POST', { title, synopsis: "", card_ids: [] });
            document.getElementById('sw-new-title').value = '';
            this.openStory(story.id);
        } catch (e) { console.error(e); }
    }

    async openStory(id) {
        this.currentStoryId = id;
        document.getElementById('sw-list-view').style.display = 'none';
        document.getElementById('sw-workspace-view').style.display = 'flex';
        await this.refreshWorkspace();
    }

    async refreshWorkspace() {
        if (!this.currentStoryId) return;
        try {
            this.story = await this.apiCall(`/stories/${this.currentStoryId}`);
            this.allCards = await this.apiCall('/cards/').catch(() => []);

            document.getElementById('sw-title').value = this.story.title;
            document.getElementById('sw-synopsis').value = this.story.synopsis;

            this.renderCards();
            this.renderSegments();
        } catch (e) { console.error(e); }
    }

    async updateStory(title, synopsis) {
        if (!this.story) return;
        try {
            await this.apiCall(`/stories/${this.story.id}`, 'PUT', { title, synopsis, card_ids: [] });
            this.story.title = title;
            this.story.synopsis = synopsis;
        } catch (e) { console.error(e); }
    }

    renderCards() {
        const container = document.getElementById('sw-attached-cards');
        const select = document.getElementById('sw-add-card-select');
        container.innerHTML = '';

        const attachedIds = new Set(this.story.cards.map(sc => sc.card_id));

        const voicesConfig = window.config?.get('api.tts.characterVoices') || {};
        const mainSelect = document.getElementById('sw-tts-voice');

        this.story.cards.forEach(sc => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.style.display = 'inline-flex';
            tag.style.alignItems = 'center';
            tag.style.gap = '5px';
            tag.innerHTML = `<span>${sc.card.name}</span> <button style="background:none; border:none; cursor:pointer; color:var(--error);" title="Detach">\u00d7</button>`;
            tag.querySelector('button').addEventListener('click', () => this.detachCard(sc.card_id));
            
            if (mainSelect && mainSelect.options.length > 1) {
                const voiceSelect = document.createElement('select');
                voiceSelect.className = 'input sw-character-voice-inline';
                voiceSelect.style.padding = '0.1rem 0.5rem';
                voiceSelect.style.fontSize = '0.8rem';
                voiceSelect.style.height = 'auto';
                voiceSelect.style.marginLeft = '5px';
                voiceSelect.style.background = 'var(--bg-primary)';
                
                const defaultOpt = document.createElement('option');
                defaultOpt.value = '';
                defaultOpt.textContent = 'Default Voice';
                voiceSelect.appendChild(defaultOpt);

                Array.from(mainSelect.options).forEach(opt => {
                    if (opt.value) {
                        const clone = opt.cloneNode(true);
                        voiceSelect.appendChild(clone);
                    }
                });
                
                voiceSelect.value = voicesConfig[sc.card.name] || '';
                
                voiceSelect.addEventListener('change', () => {
                    const map = window.config?.get('api.tts.characterVoices') || {};
                    if (voiceSelect.value) {
                        map[sc.card.name] = voiceSelect.value;
                    } else {
                        delete map[sc.card.name];
                    }
                    window.config?.set('api.tts.characterVoices', map);
                });
                
                tag.insertBefore(voiceSelect, tag.querySelector('button'));
            }

            container.appendChild(tag);
        });

        const available = this.allCards.filter(c => !attachedIds.has(c.id));
        select.innerHTML = '<option value="">+ Add Character</option>';
        available.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            select.appendChild(opt);
        });
        select.disabled = available.length === 0;

        let galleryBtn = document.getElementById('sw-add-card-gallery-btn');
        if (!galleryBtn) {
            galleryBtn = document.createElement('button');
            galleryBtn.id = 'sw-add-card-gallery-btn';
            galleryBtn.className = 'btn-small btn-outline';
            galleryBtn.textContent = '🖼️ Gallery';
            galleryBtn.style.marginLeft = '0.5rem';
            galleryBtn.addEventListener('click', () => {
                if (window.cardGallery) {
                    window.cardGallery.open(available, (cardId) => {
                        this.attachCard(cardId);
                    });
                }
            });
            select.parentNode.insertBefore(galleryBtn, select.nextSibling);
        }
        galleryBtn.disabled = available.length === 0;
    }

    async attachCard(cardId) {
        try { await this.apiCall(`/stories/${this.story.id}/cards/${cardId}`, 'POST'); await this.refreshWorkspace(); } catch (e) { console.error(e); }
    }

    async detachCard(cardId) {
        try { await this.apiCall(`/stories/${this.story.id}/cards/${cardId}`, 'DELETE'); await this.refreshWorkspace(); } catch (e) { console.error(e); }
    }

    renderSegments() {
        const area = document.getElementById('sw-story-area');
        area.innerHTML = '';

        this.story.segments.forEach(seg => {
            if (seg.is_summary) return; // Do not render summary segments to the user

            const div = document.createElement('div');
            div.dataset.segmentId = seg.id;
            div.className = 'sw-segment-card';

            const content = document.createElement('div');
            content.style.lineHeight = '1.7';
            content.style.whiteSpace = 'pre-wrap';
            content.textContent = seg.content;

            // Inline editor (hidden by default)
            const editor = document.createElement('textarea');
            editor.className = 'textarea';
            editor.style.display = 'none';
            editor.style.width = '100%';
            editor.style.minHeight = '8rem';
            editor.style.marginTop = '0.5rem';
            editor.style.background = 'var(--surface-color)';
            editor.value = seg.content;

            // Image area (hidden until generated)
            const imageArea = document.createElement('div');
            imageArea.style.marginTop = '0.75rem';
            imageArea.style.display = 'none';

            const actions = document.createElement('div');
            actions.className = 'sw-segment-actions';

            const playingBadge = document.createElement('span');
            playingBadge.className = 'sw-segment-playing-badge';
            playingBadge.style.cssText = 'font-size:0.75rem; color:var(--success-color,#2d9f66); font-weight:600; display:none;';
            playingBadge.textContent = 'Playing';
            actions.appendChild(playingBadge);

            const editBtn = document.createElement('button');
            editBtn.className = 'btn-small';
            editBtn.textContent = '✏️';
            editBtn.title = 'Edit segment';
            editBtn.addEventListener('click', () => {
                const editing = editor.style.display !== 'none';
                if (editing) {
                    editor.value = seg.content;
                    editor.style.display = 'none';
                    content.style.display = '';
                    editBtn.textContent = '✏️';
                    saveBtn.style.display = 'none';
                } else {
                    editor.style.display = 'block';
                    content.style.display = 'none';
                    editBtn.textContent = '❌';
                    saveBtn.style.display = '';
                    editor.focus();
                }
            });

            const saveBtn = document.createElement('button');
            saveBtn.className = 'btn-small btn-primary';
            saveBtn.textContent = '💾';
            saveBtn.title = 'Save changes';
            saveBtn.style.display = 'none';
            saveBtn.addEventListener('click', async () => {
                const newText = editor.value;
                saveBtn.disabled = true;
                saveBtn.textContent = '⏳';
                try {
                    await this.apiCall(`/stories/${this.story.id}/segments/${seg.id}`, 'PUT', { content: newText });
                    seg.content = newText;
                    content.textContent = newText;
                    editor.style.display = 'none';
                    content.style.display = '';
                    editBtn.textContent = '✏️';
                    saveBtn.style.display = 'none';
                } catch (e) {
                    alert('Failed to save: ' + e.message);
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.textContent = '💾';
                }
            });

            const playBtn = document.createElement('button');
            playBtn.className = 'btn-small';
            playBtn.textContent = '▶';
            playBtn.title = 'Play from this point in the story';
            playBtn.addEventListener('click', () => this.playFromSegmentIndex(this.story.segments.indexOf(seg)));

            const imgBtn = document.createElement('button');
            imgBtn.className = 'btn-small';
            imgBtn.textContent = '🎨';
            imgBtn.title = 'Generate Image';
            imgBtn.addEventListener('click', async () => {
                if (!window.apiHandler) {
                    alert('Image API not available. Make sure your Image API is configured in \u2699\ufe0f API Settings.');
                    return;
                }
                imgBtn.disabled = true;
                imgBtn.textContent = '⏳';
                imageArea.style.display = 'block';
                imageArea.innerHTML = '<span style="font-size:0.85rem; color:var(--text-secondary);">Creating scene prompt\u2026</span>';
                try {
                    const res = await window.authFetch('/api/sw/generate/image-prompt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ story_id: this.story.id, segment_id: seg.id }),
                    });
                    if (!res.ok) {
                        const j = await res.json().catch(() => ({}));
                        throw new Error(j.detail || j.error || `Failed to generate prompt (${res.status})`);
                    }
                    const { prompt } = await res.json();

                    imageArea.innerHTML = `<span style="font-size:0.75rem; color:var(--text-secondary); font-style:italic; display:block; margin-bottom:0.5rem;">Prompt: ${prompt}</span><span style="font-size:0.85rem; color:var(--text-secondary);">Generating image\u2026</span>`;

                    const swImageModel = (document.getElementById('sw-image-model')?.value || '') || null;
                    const imageUrl = await window.apiHandler.generateImage(null, null, prompt, swImageModel);

                    const img = document.createElement('img');
                    img.src = imageUrl;
                    img.style.maxWidth = '100%';
                    img.style.borderRadius = '0.5rem';
                    img.style.marginTop = '0.25rem';
                    img.style.display = 'block';
                    const promptNote = document.createElement('span');
                    promptNote.style.cssText = 'font-size:0.72rem; color:var(--text-secondary); font-style:italic; display:block; margin-bottom:0.4rem;';
                    promptNote.textContent = `Prompt: ${prompt}`;
                    imageArea.innerHTML = '';
                    imageArea.appendChild(promptNote);
                    imageArea.appendChild(img);

                    imgBtn.textContent = '🎨';
                } catch (e) {
                    imageArea.innerHTML = `<span style="font-size:0.85rem; color:var(--error-color,#e55);">Image generation failed: ${e.message}</span>`;
                    imgBtn.textContent = '🎨';
                    console.error('[StoryWriter] Image generation error:', e);
                } finally {
                    imgBtn.disabled = false;
                }
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-small';
            delBtn.textContent = '🗑️';
            delBtn.title = 'Delete Segment';
            delBtn.addEventListener('click', async () => {
                if (confirm('Delete segment?')) {
                    await this.apiCall(`/stories/${this.story.id}/segments/${seg.id}`, 'DELETE');
                    await this.refreshWorkspace();
                }
            });

            actions.appendChild(playingBadge);
            actions.appendChild(playBtn);
            actions.appendChild(delBtn);
            actions.appendChild(editBtn);
            actions.appendChild(imgBtn);
            actions.appendChild(saveBtn);
            
            div.appendChild(actions);
            div.appendChild(content);
            div.appendChild(editor);
            div.appendChild(imageArea);
            area.appendChild(div);
        });

        // Re-apply the active playback indicator after rendering segments
        if (this.currentPlayingSegmentId !== null) {
            this._updateSegmentPlayingIndicator(this.currentPlayingSegmentId);
        }
    }

    _updateSegmentPlayingIndicator(segmentId) {
        this.currentPlayingSegmentId = segmentId;
        const segmentEls = document.querySelectorAll('#sw-story-area [data-segment-id]');
        segmentEls.forEach(el => {
            const badge = el.querySelector('.sw-segment-playing-badge');
            const isActive = segmentId !== null && String(el.dataset.segmentId) === String(segmentId);
            if (badge) {
                badge.style.display = isActive ? 'inline-flex' : 'none';
            }
            el.style.boxShadow = isActive ? '0 0 0 2px rgba(45,159,102,0.18)' : '';
        });
    }

    _clearPlayingSegmentIndicator() {
        this._updateSegmentPlayingIndicator(null);
    }

    // ── Narration control helpers ──────────────────────────────────────────────

    _showNarrationControls() {
        console.debug('[StoryWriter][TTS] Showing narration controls');
        const bar = document.getElementById('sw-narration-controls');
        if (bar) bar.style.display = 'flex';
    }

    _hideNarrationControls() {
        console.debug('[StoryWriter][TTS] Hiding narration controls');
        const bar = document.getElementById('sw-narration-controls');
        if (bar) bar.style.display = 'none';
        const progress = document.getElementById('sw-tts-progress');
        if (progress) progress.textContent = '';
    }

    playFromSegmentIndex(index) {
        if (!this.story || !Number.isInteger(index) || index < 0 || index >= this.story.segments.length) {
            return;
        }

        const ttsVoice = document.getElementById('sw-tts-voice')?.value || 'p230';
        const ttsSpeed = parseFloat(document.getElementById('sw-tts-speed')?.value || '1.0');
        const volume = parseInt(document.getElementById('sw-tts-volume')?.value || '80', 10);
        const autoMode = document.getElementById('sw-auto-mode')?.checked || false;

        if (this.ttsPlayer) {
            this.ttsPlayer.stop();
            this.ttsPlayer = null;
        }

        this.ttsPlayer = new TTSPlayer();
        this.ttsPlayer.voice = ttsVoice;
        this.ttsPlayer.speed = ttsSpeed;
        this.ttsPlayer.setVolume(volume);
        this.ttsPlayer.provider = document.getElementById('sw-tts-provider')?.value || 'local';
        this.ttsPlayer.googleApiKey = document.getElementById('sw-tts-google-key')?.value || '';
        this.ttsPlayer.nanogptKey = document.getElementById('sw-tts-nanogpt-key')?.value || '';
        this.ttsPlayer.nanogptModel = document.getElementById('sw-tts-nanogpt-model')?.value || '';
        this.ttsPlayer.nanogptVoice = document.getElementById('sw-tts-nanogpt-voice')?.value || '';
        this._showNarrationControls();
        const pauseBtn = document.getElementById('sw-tts-pause-btn');
        if (pauseBtn) pauseBtn.textContent = '\u23f8 Pause';

        this.ttsPlayer.onQueueLow = () => {
            const isAuto = document.getElementById('sw-auto-mode')?.checked || false;
            if (isAuto && !this.isFetchingLLM) {
                this.generateNext();
            }
        };
        this._updateSegmentPlayingIndicator(this.story.segments[index].id);
        this.ttsPlayer.onQueueEmpty = () => {
            this._updateNarrationProgress('');
            const isAuto = document.getElementById('sw-auto-mode')?.checked || false;
            if (!isAuto && !this.isFetchingLLM) {
                this._clearPlayingSegmentIndicator();
                this._hideNarrationControls();
            }
        };

        const detector = new SentenceDetector();
        const segmentsToPlay = this.story.segments.slice(index);
        let queued = 0;

        segmentsToPlay.forEach(seg => {
            const sentences = detector.feed(seg.content + '\n');
            sentences.forEach(sentence => {
                this.ttsPlayer.enqueue(sentence);
                queued += 1;
            });
        });

        detector.flush().forEach(sentence => {
            this.ttsPlayer.enqueue(sentence);
            queued += 1;
        });

        if (queued > 0) {
            this._updateNarrationProgress('Speaking...');
        } else {
            this._updateNarrationProgress('No text available to play.');
            this._hideNarrationControls();
        }
    }

    _updateNarrationProgress(text) {
        const progress = document.getElementById('sw-tts-progress');
        if (progress) progress.textContent = text;
    }

    _togglePause() {
        if (!this.ttsPlayer) return;
        const btn = document.getElementById('sw-tts-pause-btn');
        if (this.ttsPlayer.paused) {
            this.ttsPlayer.resume();
            if (btn) btn.textContent = '\u23f8 Pause';
        } else {
            this.ttsPlayer.pause();
            if (btn) btn.textContent = '\u25b6 Resume';
        }
    }

    _stopNarration() {
        console.debug('[StoryWriter][TTS] Stop narration triggered');
        if (this.ttsPlayer) {
            this.ttsPlayer.stop();
            this.ttsPlayer = null;
        }
        this._clearPlayingSegmentIndicator();
        this._hideNarrationControls();
    }

    async _extractAndPlayAudiobook(text, voices, defaultVoice) {
        if (!text || !this.ttsPlayer || this.ttsPlayer.stopped) return;
        
        try {
            const prompt = `Given the following story segment, extract all sentences and attribute them to a speaker. 
Output exactly a JSON array of objects with keys "speaker" and "text". 
Use "Narrator" for non-dialogue descriptive sentences. Do not include markdown formatting or any other text.

Segment:
${text}`;

            const res = await (window.authFetch || fetch)('/api/text/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: prompt }],
                    model: window.config?.get('api.text.model') || '',
                    temperature: 0.1
                })
            });

            if (!res.ok) throw new Error('Extraction LLM failed');
            if (this.ttsPlayer.stopped) return;
            
            const data = await res.json();
            let content = data.choices?.[0]?.message?.content || '[]';
            content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
            
            const parsed = JSON.parse(content);
            if (!Array.isArray(parsed)) throw new Error('Invalid JSON format');
            
            parsed.forEach(item => {
                if (item.text && item.text.trim()) {
                    let speaker = item.speaker || 'Narrator';
                    const voice = voices[speaker] || voices['Narrator'] || defaultVoice;
                    this.ttsPlayer.enqueue(item.text, voice);
                }
            });
            
            this._updateNarrationProgress('Speaking...');
        } catch (e) {
            console.error('[StoryWriter][TTS] Failed to extract audiobook voices, falling back to default voice.', e);
            if (this.ttsPlayer && !this.ttsPlayer.stopped) {
                const detector = new SentenceDetector();
                const sentences = detector.feed(text);
                detector.flush().forEach(s => sentences.push(s));
                sentences.forEach(s => this.ttsPlayer.enqueue(s, defaultVoice));
                this._updateNarrationProgress('Speaking...');
            }
        }
    }

    // ── Generate next story chunk (with optional TTS narration) ────────────────

    async generateNext() {
        if (this.isFetchingLLM || !this.story || this._pollingInterval) return;
        const steeringInput = document.getElementById('sw-steering');
        let steering = steeringInput.value.trim();
        const btn = document.getElementById('sw-generate-btn');
        const area = document.getElementById('sw-story-area');

        const scriptMode = document.getElementById('sw-script-mode')?.checked || false;
        const characterVoices = window.config?.get('api.tts.characterVoices') || {};

        let modifiedSteering = steering;
        if (scriptMode) {
            const scriptInstruction = "SYSTEM INSTRUCTION: You MUST write exclusively in a script format. Every line must begin with the character's name, or 'Narrator', followed by a colon. Do not write normal prose.";
            modifiedSteering = modifiedSteering ? (modifiedSteering + "\n\n" + scriptInstruction) : scriptInstruction;
        }

        this.isFetchingLLM = true;
        btn.textContent = 'Generating...';
        btn.disabled = true;
        const stopBtn = document.getElementById('sw-stop-btn');
        if (stopBtn) stopBtn.style.display = 'inline-block';
        this.abortController = new AbortController();

        // ── Set up TTS if enabled ──────────────────────────────────────────────
        const ttsEnabled = document.getElementById('sw-tts-enabled')?.checked || false;
        const autoMode   = document.getElementById('sw-auto-mode')?.checked || false;
        const ttsVoice   = document.getElementById('sw-tts-voice')?.value || 'p230';
        const ttsSpeed   = parseFloat(document.getElementById('sw-tts-speed')?.value || '1.0');
        const volume     = parseInt(document.getElementById('sw-tts-volume')?.value || '80', 10);
        console.debug('[StoryWriter][TTS] GenerateNext settings', { ttsEnabled, autoMode, ttsVoice, ttsSpeed, volume });

        let sentenceDetector = null;
        if (ttsEnabled) {
            let isNewPlayer = false;
            if (!this.ttsPlayer || this.ttsPlayer.stopped) {
                this.ttsPlayer = new TTSPlayer();
                isNewPlayer = true;
            }
            this.ttsPlayer.voice = ttsVoice;
            this.ttsPlayer.speed = ttsSpeed;
            this.ttsPlayer.setVolume(volume);
            this.ttsPlayer.provider = document.getElementById('sw-tts-provider')?.value || 'local';
            this.ttsPlayer.googleApiKey = document.getElementById('sw-tts-google-key')?.value || '';
            this._showNarrationControls();
            const pauseBtn = document.getElementById('sw-tts-pause-btn');
            if (pauseBtn) pauseBtn.textContent = '\u23f8 Pause';

            if (isNewPlayer) {
                this.ttsPlayer.onQueueLow = () => {
                    const isAuto = document.getElementById('sw-auto-mode')?.checked || false;
                    if (isAuto && !this.isFetchingLLM) {
                        console.debug('[StoryWriter] Queue low, pipelining next generation.');
                        this.generateNext();
                    }
                };

                this.ttsPlayer.onQueueEmpty = () => {
                    this._updateNarrationProgress('');
                    const isAuto = document.getElementById('sw-auto-mode')?.checked || false;
                    if (!isAuto && !this.isFetchingLLM) {
                        this._hideNarrationControls();
                    }
                };
            }

            sentenceDetector = new SentenceDetector();
        } else {
            // TTS disabled — clean up any existing player
            if (this.ttsPlayer) {
                this.ttsPlayer.stop();
                this.ttsPlayer = null;
            }
            this._hideNarrationControls();
        }

        const streamDiv = document.createElement('div');
        streamDiv.style.padding = '1rem';
        streamDiv.style.marginBottom = '1rem';
        streamDiv.style.background = 'var(--bg-tertiary)';
        streamDiv.style.borderRadius = '0.5rem';
        streamDiv.style.border = '1px dashed var(--accent)';
        streamDiv.style.whiteSpace = 'pre-wrap';
        streamDiv.style.lineHeight = '1.7';
        area.appendChild(streamDiv);

        // Auto-scroll to the bottom so the new segment and controls are visible
        setTimeout(() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        }, 50);

        try {
            const res = await window.authFetch('/api/sw/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ story_id: this.story.id, steering: modifiedSteering || null }),
                signal: this.abortController.signal
            });

            if (!res.ok) {
                const errText = await res.text();
                let errMsg = `Generation failed (${res.status})`;
                try { const j = JSON.parse(errText); errMsg = j.detail || j.error || errMsg; } catch (_) {}
                streamDiv.remove();
                
                if (res.status >= 500 || res.status === 408) {
                    console.warn(`[StoryWriter] Received ${res.status}, but server might have succeeded in background. Refreshing workspace...`);
                    // Don't alert, just refresh the workspace to pull the background-generated content
                    await this.refreshWorkspace();
                } else if (errMsg.toLowerCase().includes('api key')) {
                    alert('\u26a0\ufe0f ' + errMsg + '\n\nPlease configure your API credentials via \u2699\ufe0f API Settings in the footer.');
                } else {
                    alert('Generation failed: ' + errMsg);
                }
                
                // Clean up TTS on error
                if (this.ttsPlayer) {
                    this.ttsPlayer.stop();
                    this._hideNarrationControls();
                }
                
                // Must manually clean up fetching state since we return early
                this.isFetchingLLM = false;
                this.abortController = null;
                btn.textContent = 'Generate Next';
                btn.disabled = false;
                if (stopBtn) stopBtn.style.display = 'none';
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let sseBuffer = '';
            let processedTTSLength = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                const lines = sseBuffer.split('\n\n');
                sseBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type === 'api_log' && window.apiHandler) { window.apiHandler.addBackendLog(data.log); } else if (data.type === 'chunk') {
                                // Display the chunk
                                streamDiv.textContent += data.content;

                                // Feed to TTS
                                if (ttsEnabled && this.ttsPlayer && !this.ttsPlayer.stopped) {
                                    let fullText = streamDiv.textContent;
                                    
                                    // Remove think blocks
                                    fullText = fullText.replace(/<think>[\s\S]*?<\/think>/g, '');
                                    fullText = fullText.replace(/<think>[\s\S]*$/g, '');
                                    const suffixes = ['<', '<t', '<th', '<thi', '<thin', '<think', '</', '</t', '</th', '</thi', '</thin', '</think'];
                                    for (const suffix of suffixes) {
                                        if (fullText.endsWith(suffix)) {
                                            fullText = fullText.slice(0, fullText.length - suffix.length);
                                            break;
                                        }
                                    }
                                    
                                    if (scriptMode) {
                                        // Real-time Script Mode Parsing
                                        const lines = fullText.split('\n');
                                        if (lines.length - 1 > processedTTSLength) {
                                            for (let i = processedTTSLength; i < lines.length - 1; i++) {
                                                const line = lines[i].trim();
                                                if (line) {
                                                    const match = line.match(/^([^:]+):\s*(.*)/);
                                                    let speaker = 'Narrator';
                                                    let speech = line;
                                                    if (match) {
                                                        speaker = match[1].trim();
                                                        speech = match[2].trim();
                                                    }
                                                    const voice = characterVoices[speaker] || characterVoices['Narrator'] || ttsVoice;
                                                    this.ttsPlayer.enqueue(speech, voice);
                                                }
                                            }
                                            processedTTSLength = lines.length - 1;
                                            this._updateNarrationProgress('Speaking...');
                                        }
                                    } else if (sentenceDetector && Object.keys(characterVoices).length === 0) {
                                        // Legacy real-time mode (only if no custom character voices)
                                        if (fullText.length > processedTTSLength) {
                                            const newText = fullText.slice(processedTTSLength);
                                            processedTTSLength = fullText.length;
                                            const sentences = sentenceDetector.feed(newText);
                                            sentences.forEach(s => this.ttsPlayer.enqueue(s, ttsVoice));
                                            if (sentences.length > 0) {
                                                this._updateNarrationProgress('Speaking...');
                                            }
                                        }
                                    }
                                }
                            } else if (data.type === 'trim') {
                                // Backend trimmed to last sentence — update display
                                streamDiv.textContent = data.content;
                            } else if (data.type === 'error') {
                                alert(data.message);
                            }
                        } catch (_) {}
                    }
                }
            }

            if (ttsEnabled && this.ttsPlayer && !this.ttsPlayer.stopped) {
                let fullText = streamDiv.textContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                
                if (scriptMode) {
                    // Flush final line for script mode
                    const lines = fullText.split('\n');
                    if (lines.length > processedTTSLength) {
                        for (let i = processedTTSLength; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (line) {
                                const match = line.match(/^([^:]+):\s*(.*)/);
                                let speaker = 'Narrator';
                                let speech = line;
                                if (match) {
                                    speaker = match[1].trim();
                                    speech = match[2].trim();
                                }
                                const voice = characterVoices[speaker] || characterVoices['Narrator'] || ttsVoice;
                                this.ttsPlayer.enqueue(speech, voice);
                            }
                        }
                    }
                } else if (Object.keys(characterVoices).length > 0) {
                    // Audiobook Buffered Plan C Extraction
                    this._updateNarrationProgress('Extracting speakers...');
                    this._extractAndPlayAudiobook(fullText, characterVoices, ttsVoice);
                } else if (sentenceDetector) {
                    // Legacy flush
                    const remaining = sentenceDetector.flush();
                    remaining.forEach(s => this.ttsPlayer.enqueue(s, ttsVoice));
                }
            }

            if (steeringInput.value.trim() === steering) {
                steeringInput.value = '';
            }
            await this.refreshWorkspace();
        } catch (e) {
            console.error('[StoryWriter] Generation stream error:', e);
            const isAbort = e.name === 'AbortError' || e.message?.includes('abort') || e.message?.includes('stopped by user');
            const isWakeAbort = isAbort && this._wakeAbort;
            this._wakeAbort = false; // always clear the flag

            if (streamDiv && streamDiv.parentNode) {
                streamDiv.remove();
            }

            if (!isAbort || isWakeAbort) {
                // Network drop (phone lock / 503) or a wake-recovery abort:
                // the server is likely still generating the segment in the background.
                // We must poll the server until the new segment appears in the DB.
                const baselineCount = document.querySelectorAll('#sw-story-area [data-segment-id]').length;
                this._pollForNewSegment(baselineCount);
            }
            // Plain user-stop (stop button): do NOT refresh — user intentionally stopped,
            // and refreshWorkspace would scroll them unexpectedly.

            if (this.ttsPlayer) {
                this.ttsPlayer.stop();
                this._hideNarrationControls();
            }
        } finally {
            this.isFetchingLLM = false;
            this.abortController = null;
            if (!this._pollingInterval) {
                btn.textContent = 'Generate Next';
                btn.disabled = false;
                if (stopBtn) stopBtn.style.display = 'none';
            }
            
            const isAuto = document.getElementById('sw-auto-mode')?.checked || false;
            const wasAborted = stopBtn?.dataset?.aborted === "true";
            
            if (isAuto && this.ttsPlayer && !this.ttsPlayer.stopped && !wasAborted) {
                if (this.ttsPlayer.textQueue.length === 0) {
                    this.generateNext();
                }
            }
            
            if (stopBtn) delete stopBtn.dataset.aborted;
        }
    }

    async _pollForNewSegment(baselineCount) {
        if (this._pollingInterval) return;
        
        const btn = document.getElementById('sw-generate-btn');
        if (btn) {
            btn.textContent = 'Polling...';
            btn.disabled = true;
        }
        const stopBtn = document.getElementById('sw-stop-btn');
        if (stopBtn) stopBtn.style.display = 'inline-block';
        
        // Polling loop
        this._pollingInterval = setInterval(async () => {
            try {
                const story = await this.apiCall(`/stories/${this.currentStoryId}`);
                const dbCount = (story.segments || []).filter(s => !s.is_summary).length;
                if (dbCount > baselineCount) {
                    clearInterval(this._pollingInterval);
                    this._pollingInterval = null;
                    await this.refreshWorkspace();
                    
                    if (btn) {
                        btn.textContent = 'Generate Next';
                        btn.disabled = false;
                    }
                    if (stopBtn) stopBtn.style.display = 'none';
                }
            } catch (e) {}
        }, 3000);
    }

    stopGeneration() {
        if (this.isFetchingLLM || this._pollingInterval) {
            console.debug('[StoryWriter] Stop generation triggered');
            const stopBtn = document.getElementById('sw-stop-btn');
            if (stopBtn) stopBtn.dataset.aborted = "true";
            if (this.abortController) {
                this.abortController.abort();
                this.abortController = null;
            }
            if (this._pollingInterval) {
                clearInterval(this._pollingInterval);
                this._pollingInterval = null;
                const genBtn = document.getElementById('sw-generate-btn');
                if (genBtn) {
                    genBtn.textContent = 'Generate Next';
                    genBtn.disabled = false;
                }
                if (stopBtn) stopBtn.style.display = 'none';
            }
        }
    }
}

window.storyWriterApp = new StoryWriterApp();
