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
    enqueue(text) {
        if (!text || !text.trim()) return;
        const trimmed = text.trim();
        console.debug('[TTSPlayer] Enqueue sentence', trimmed);
        this.textQueue.push(trimmed);
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

        // Keep one sentence buffered ahead.
        if (this.audioQueue.length >= 2) {
            return;
        }

        this.loading = true;
        const text = this.textQueue.shift();
        
        if (this.textQueue.length === 0 && !this._queueLowFired && !this.stopped) {
            this._queueLowFired = true;
            if (this.onQueueLow) this.onQueueLow();
        }
        console.debug('[TTSPlayer] Loading audio for sentence', text);
        try {
            const res = await window.authFetch('/api/tts/synthesize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice: this.voice, speed: this.speed, provider: this.provider, googleApiKey: this.googleApiKey }),
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                console.warn('[TTSPlayer] Synthesis HTTP', res.status, errText, '— skipping sentence');
                if (this.onError) this.onError(`HTTP ${res.status}: ${errText || 'Failed'}`);
            } else {
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
            if (this.onError) this.onError(`Network error: ${e.message}`);
        } finally {
            this.loading = false;
            if (!this.stopped && !this.paused) {
                if (this.textQueue.length > 0 && this.audioQueue.length < 2) {
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
     * Feed a chunk of text. Returns an array of complete sentences found.
     * Incomplete trailing text stays in the internal buffer.
     */
    feed(chunk) {
        this.buffer += chunk;
        const sentences = [];
        // Match lazily up to punctuation + optional quotes, avoiding splits at common abbreviations.
        const re = /([\s\S]+?(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|Rev|Capt|Gen|St|Sgt|Sr|Jr|vs|etc))[.!?]+["'\u201D\u2019)\]]*)(?=\s+[A-Z"\u201C\u2018]|\s*\n|$)/g;
        let match;
        let lastIndex = 0;
        while ((match = re.exec(this.buffer)) !== null) {
            sentences.push(match[0].trim());
            lastIndex = match.index + match[0].length;
        }
        if (lastIndex > 0) {
            this.buffer = this.buffer.slice(lastIndex);
        }
        return sentences;
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

        document.addEventListener('DOMContentLoaded', () => {
            this.bindEvents();
        });
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
                const isGoogle = providerSelect.value.startsWith('google');
                document.getElementById('sw-tts-google-key-container').style.display = isGoogle ? 'block' : 'none';
                this.loadVoices();
            });
        }
        document.getElementById('sw-tts-google-key')?.addEventListener('change', () => this.loadVoices());
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
            let savedProvider = localStorage.getItem('sw-tts-provider') || 'local';
            if (savedProvider === 'google') savedProvider = 'google-premium';
            const savedGoogleKey = localStorage.getItem('sw-tts-google-key') || '';

            this.ttsSettings = {
                tts_enabled: s.tts_enabled || false,
                auto_mode: s.auto_mode || false,
                tts_voice: s.tts_voice || 'p230',
                tts_speed: s.tts_speed || 1.0,
                tts_provider: savedProvider,
                tts_google_key: savedGoogleKey
            };
            console.debug('[StoryWriter][TTS] Loaded settings', this.ttsSettings);

            const ttsEnabled = document.getElementById('sw-tts-enabled');
            const autoMode = document.getElementById('sw-auto-mode');
            const voiceSelect  = document.getElementById('sw-tts-voice');
            const speedSlider  = document.getElementById('sw-tts-speed');
            const speedLabel   = document.getElementById('sw-tts-speed-label');
            const providerSelect = document.getElementById('sw-tts-provider');
            const googleKeyInput = document.getElementById('sw-tts-google-key');

            if (ttsEnabled) ttsEnabled.checked = this.ttsSettings.tts_enabled;
            if (autoMode)  autoMode.checked  = this.ttsSettings.auto_mode;
            if (speedSlider) {
                speedSlider.value = this.ttsSettings.tts_speed;
                if (speedLabel) speedLabel.textContent = this.ttsSettings.tts_speed + 'x';
            }
            if (providerSelect) {
                providerSelect.value = this.ttsSettings.tts_provider;
                document.getElementById('sw-tts-google-key-container').style.display = this.ttsSettings.tts_provider.startsWith('google') ? 'block' : 'none';
            }
            if (googleKeyInput) {
                googleKeyInput.value = this.ttsSettings.tts_google_key;
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
        const ttsVoice   = document.getElementById('sw-tts-voice')?.value || 'p230';
        const ttsSpeed   = parseFloat(document.getElementById('sw-tts-speed')?.value || '1.0');
        const ttsProvider = document.getElementById('sw-tts-provider')?.value || 'local';
        const ttsGoogleKey = document.getElementById('sw-tts-google-key')?.value || '';

        localStorage.setItem('sw-tts-provider', ttsProvider);
        localStorage.setItem('sw-tts-google-key', ttsGoogleKey);

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
            tts_google_key: ttsGoogleKey
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
        const provider = document.getElementById('sw-tts-provider')?.value || 'local';
        const googleKey = document.getElementById('sw-tts-google-key')?.value || '';

        if (!voiceSelect) return;

        try {
            let res;
            if (provider.startsWith('google')) {
                if (!googleKey) {
                    voiceSelect.innerHTML = '<option value="">— Enter API Key —</option>';
                    if (statusSpan) statusSpan.textContent = 'Key required';
                    return;
                }
                const tier = provider === 'google-standard' ? 'standard' : 'premium';
                res = await window.authFetch(`/api/tts/google-voices?key=${googleKey}&tier=${tier}`);
            } else {
                res = await window.authFetch('/api/tts/voices');
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

        this.story.cards.forEach(sc => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.style.display = 'inline-flex';
            tag.style.alignItems = 'center';
            tag.style.gap = '5px';
            tag.innerHTML = `${sc.card.name} <button style="background:none; border:none; cursor:pointer; color:var(--error);" title="Detach">\u00d7</button>`;
            tag.querySelector('button').addEventListener('click', () => this.detachCard(sc.card_id));
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
            const div = document.createElement('div');
            div.dataset.segmentId = seg.id;
            div.style.padding = '1rem';
            div.style.marginBottom = '1rem';
            div.style.background = 'var(--bg-tertiary)';
            div.style.borderRadius = '0.5rem';
            div.style.borderLeft = seg.is_summary ? '3px solid #f9a825' : '3px solid var(--accent)';

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
            actions.style.marginTop = '0.75rem';
            actions.style.display = 'flex';
            actions.style.gap = '0.5rem';
            actions.style.justifyContent = 'space-between';
            actions.style.alignItems = 'center';
            actions.style.flexWrap = 'wrap';

            const playingBadge = document.createElement('span');
            playingBadge.className = 'sw-segment-playing-badge';
            playingBadge.style.cssText = 'font-size:0.75rem; color:var(--success-color,#2d9f66); font-weight:600; display:none;';
            playingBadge.textContent = 'Playing';
            actions.appendChild(playingBadge);

            const editBtn = document.createElement('button');
            editBtn.className = 'btn-small';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => {
                const editing = editor.style.display !== 'none';
                if (editing) {
                    editor.value = seg.content;
                    editor.style.display = 'none';
                    content.style.display = '';
                    editBtn.textContent = 'Edit';
                    saveBtn.style.display = 'none';
                } else {
                    editor.style.display = 'block';
                    content.style.display = 'none';
                    editBtn.textContent = 'Cancel';
                    saveBtn.style.display = '';
                    editor.focus();
                }
            });

            const saveBtn = document.createElement('button');
            saveBtn.className = 'btn-small btn-primary';
            saveBtn.textContent = 'Save';
            saveBtn.style.display = 'none';
            saveBtn.addEventListener('click', async () => {
                const newText = editor.value;
                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving\u2026';
                try {
                    await this.apiCall(`/stories/${this.story.id}/segments/${seg.id}`, 'PUT', { content: newText });
                    seg.content = newText;
                    content.textContent = newText;
                    editor.style.display = 'none';
                    content.style.display = '';
                    editBtn.textContent = 'Edit';
                    saveBtn.style.display = 'none';
                } catch (e) {
                    alert('Failed to save: ' + e.message);
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save';
                }
            });

            const playBtn = document.createElement('button');
            playBtn.className = 'btn-small';
            playBtn.textContent = '▶ Play';
            playBtn.title = 'Play from this point in the story';
            playBtn.addEventListener('click', () => this.playFromSegmentIndex(this.story.segments.indexOf(seg)));

            const imgBtn = document.createElement('button');
            imgBtn.className = 'btn-small';
            imgBtn.textContent = '\ud83c\udfa8 Generate Image';
            imgBtn.addEventListener('click', async () => {
                if (!window.apiHandler) {
                    alert('Image API not available. Make sure your Image API is configured in \u2699\ufe0f API Settings.');
                    return;
                }
                imgBtn.disabled = true;
                imgBtn.textContent = '\ud83c\udfa8 Generating\u2026';
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

                    imgBtn.textContent = '\ud83c\udfa8 Regenerate Image';
                } catch (e) {
                    imageArea.innerHTML = `<span style="font-size:0.85rem; color:var(--error-color,#e55);">Image generation failed: ${e.message}</span>`;
                    imgBtn.textContent = '\ud83c\udfa8 Generate Image';
                    console.error('[StoryWriter] Image generation error:', e);
                } finally {
                    imgBtn.disabled = false;
                }
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-small';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', async () => {
                if (confirm('Delete segment?')) {
                    await this.apiCall(`/stories/${this.story.id}/segments/${seg.id}`, 'DELETE');
                    await this.refreshWorkspace();
                }
            });

            actions.appendChild(playBtn);
            actions.appendChild(imgBtn);
            actions.appendChild(editBtn);
            actions.appendChild(saveBtn);
            actions.appendChild(delBtn);
            div.appendChild(content);
            div.appendChild(editor);
            div.appendChild(imageArea);
            div.appendChild(actions);
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

    // ── Generate next story chunk (with optional TTS narration) ────────────────

    async generateNext() {
        if (this.isFetchingLLM || !this.story) return;
        const steering = document.getElementById('sw-steering').value.trim();
        const btn = document.getElementById('sw-generate-btn');
        const area = document.getElementById('sw-story-area');

        this.isFetchingLLM = true;
        btn.textContent = 'Generating...';
        btn.disabled = true;
        const stopBtn = document.getElementById('sw-stop-btn');
        if (stopBtn) stopBtn.style.display = 'inline-block';

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

        try {
            const res = await window.authFetch('/api/sw/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ story_id: this.story.id, steering: steering || null })
            });

            if (!res.ok) {
                const errText = await res.text();
                let errMsg = `Generation failed (${res.status})`;
                try { const j = JSON.parse(errText); errMsg = j.detail || j.error || errMsg; } catch (_) {}
                streamDiv.remove();
                if (errMsg.toLowerCase().includes('api key')) {
                    alert('\u26a0\ufe0f ' + errMsg + '\n\nPlease configure your API credentials via \u2699\ufe0f API Settings in the footer.');
                } else {
                    alert('Generation failed: ' + errMsg);
                }
                // Clean up TTS on error
                if (this.ttsPlayer) {
                    this.ttsPlayer.stop();
                    this._hideNarrationControls();
                }
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let sseBuffer = '';

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
                            if (data.type === 'chunk') {
                                // Display the chunk
                                streamDiv.textContent += data.content;

                                // Feed to sentence detector for TTS
                                if (sentenceDetector && this.ttsPlayer && !this.ttsPlayer.stopped) {
                                    const sentences = sentenceDetector.feed(data.content);
                                    sentences.forEach(s => this.ttsPlayer.enqueue(s));
                                    if (sentences.length > 0) {
                                        this._updateNarrationProgress('Speaking...');
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

            // Flush any remaining text in the sentence detector
            if (sentenceDetector && this.ttsPlayer && !this.ttsPlayer.stopped) {
                const remaining = sentenceDetector.flush();
                remaining.forEach(s => this.ttsPlayer.enqueue(s));
            }

            document.getElementById('sw-steering').value = '';
            await this.refreshWorkspace();
        } catch (e) {
            console.error(e);
            const isAbort = e.message?.includes("stopped by user") || e.name === "AbortError" || e.message?.includes("abort");
            if (!isAbort) {
                alert("Generation failed: " + e.message);
                streamDiv.remove();
            } else {
                this.refreshWorkspace();
            }
            if (this.ttsPlayer) {
                this.ttsPlayer.stop();
                this._hideNarrationControls();
            }
        } finally {
            this.isFetchingLLM = false;
            btn.textContent = 'Generate Next';
            btn.disabled = false;
            if (stopBtn) stopBtn.style.display = 'none';
            
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

    stopGeneration() {
        if (this.isFetchingLLM) {
            console.debug('[StoryWriter] Stop generation triggered');
            const stopBtn = document.getElementById('sw-stop-btn');
            if (stopBtn) stopBtn.dataset.aborted = "true";
            if (window.apiHandler) window.apiHandler.stopGeneration();
        }
    }
}

window.storyWriterApp = new StoryWriterApp();
