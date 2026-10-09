// 画面配線: プリセット選択→復元→会話開始、チャットログ、マイク、設定反映。
(() => {
  let rnvBase = "";
  let conversationId = null;
  let backendEvents = null;
  let currentPreset = null;
  let rnvSession = null;
  let replyInProgress = false;
  let liveBubble = null;
  let pendingUserBubble = null;
  let appliedRole = null;
  let appliedVoiceId = null;

  // ROLEはブラウザ側(localStorage)にpresetごとに保存する
  const ROLE_STORAGE_PREFIX = "chara-chat/role/";

  function loadSavedRole(presetId) {
    try { return localStorage.getItem(ROLE_STORAGE_PREFIX + presetId) || ""; }
    catch { return ""; }
  }

  function saveRole(presetId, role) {
    try { localStorage.setItem(ROLE_STORAGE_PREFIX + presetId, role); }
    catch {}
  }

  const presetPanel = document.getElementById("preset-panel");
  const presetList = document.getElementById("preset-list");
  const chatPanel = document.getElementById("chat-panel");
  const characterName = document.getElementById("character-name");
  const changeCharacter = document.getElementById("change-character");
  const roleInput = document.getElementById("role-input");
  const voiceIdInput = document.getElementById("voice-id-input");
  const applySettings = document.getElementById("apply-settings");
  const returnIdleToggle = document.getElementById("return-idle-toggle");
  const chatLog = document.getElementById("chat-log");
  const saveLogButton = document.getElementById("save-log");
  const chatText = document.getElementById("chat-text");
  const chatForm = document.getElementById("chat-form");
  const micToggle = document.getElementById("mic-toggle");
  const micStatus = document.getElementById("mic-status");
  const micLevel = document.getElementById("mic-level");
  const stageStatus = document.getElementById("stage-status");
  const appStatus = document.getElementById("app-status");

  function setAppStatus(text, isError = false) {
    appStatus.textContent = text;
    appStatus.classList.toggle("error", isError);
  }

  function isBusy() {
    return replyInProgress || Player.isSpeaking();
  }

  // --- チャットログ ------------------------------------------------------

  function addBubble(role, text) {
    const bubble = document.createElement("div");
    bubble.className = `bubble ${role}`;
    bubble.textContent = text;
    chatLog.appendChild(bubble);
    saveLogButton.hidden = false;
    chatLog.scrollTop = chatLog.scrollHeight;
    return bubble;
  }

  function handleBackendEvent(event) {
    if (event.type === "turn_started") {
      replyInProgress = true;
      liveBubble = null;
      // 音声入力では文字起こし(user_text)より先に返答ストリームが届くため、
      // ユーザーバブルの場所を先に確保して表示順を守る
      pendingUserBubble = addBubble("user pending", "（認識中…）");
    } else if (event.type === "user_text") {
      if (pendingUserBubble) {
        pendingUserBubble.textContent = event.text;
        pendingUserBubble.classList.remove("pending");
        pendingUserBubble = null;
      } else {
        addBubble("user", event.text);
      }
    } else if (event.type === "reply_delta") {
      if (!liveBubble) liveBubble = addBubble("assistant live", "");
      liveBubble.textContent += event.text;
      chatLog.scrollTop = chatLog.scrollHeight;
    } else if (event.type === "reply_done") {
      if (liveBubble) {
        liveBubble.classList.remove("live");
        liveBubble.textContent = event.text;
      } else {
        addBubble("assistant", event.text);
      }
      liveBubble = null;
    } else if (event.type === "error") {
      addBubble("error", event.message);
      setAppStatus(event.message, true);
    } else if (event.type === "turn_finished") {
      replyInProgress = false;
      // 文字起こしが届かないままターンが終わった場合の後始末
      if (pendingUserBubble) {
        pendingUserBubble.textContent = "（音声入力）";
        pendingUserBubble.classList.remove("pending");
        pendingUserBubble = null;
      }
    }
  }

  function connectBackendEvents() {
    if (backendEvents) backendEvents.close();
    backendEvents = new EventSource(`/api/conversations/${conversationId}/events`);
    backendEvents.onmessage = event => handleBackendEvent(JSON.parse(event.data));
  }

  // --- プリセット選択と会話開始 -----------------------------------------

  // エンジンと解像度の表示(例: "H3・352×640" / "LTX・480×640")。
  // どちらも r-n-v の /api/presets が返すフィールドから作る。
  function presetMetaText(preset) {
    const engine = (preset.video_engine || "ltx25") === "h3" ? "H3" : "LTX";
    const m = /(\d{3,4})x(\d{3,4})/.exec(preset.video_profile || "");
    return m ? `${engine}・${m[1]}×${m[2]}` : engine;
  }

  async function loadPresets() {
    presetList.textContent = "読み込み中…";
    try {
      const response = await fetch(`${rnvBase}/api/presets`);
      const presets = await response.json();
      presetList.replaceChildren(...presets.map(preset => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "preset-card";
        const img = document.createElement("img");
        img.src = `${rnvBase}${preset.thumbnail_url}`;
        img.alt = preset.name;
        const label = document.createElement("span");
        label.textContent = preset.name;
        const meta = document.createElement("span");
        meta.className = "preset-meta";
        meta.textContent = presetMetaText(preset);
        card.append(img, label, meta);
        card.addEventListener("click", () => selectPreset(preset));
        return card;
      }));
      if (!presets.length) {
        presetList.textContent =
          "登録キャラクターがありません。realtime-narration-video 側でプリセットを保存してください。";
      }
    } catch (error) {
      presetList.textContent = `プリセット一覧の取得に失敗しました: ${error.message}`;
    }
  }

  async function selectPreset(preset) {
    setAppStatus(`「${preset.name}」を復元中…`);
    try {
      const restored = await fetch(`${rnvBase}/api/presets/${preset.id}/restore`, {method: "POST"});
      if (!restored.ok) throw new Error(`HTTP ${restored.status}`);
      rnvSession = await restored.json();
      currentPreset = preset;
      roleInput.value = loadSavedRole(preset.id);
      voiceIdInput.value = rnvSession.voice_id;
      const created = await fetch("/api/conversations", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          preset_id: preset.id,
          rnv_session_id: rnvSession.id,
          role: roleInput.value,
        }),
      });
      if (!created.ok) throw new Error(`HTTP ${created.status}`);
      conversationId = (await created.json()).id;
      appliedRole = roleInput.value;
      appliedVoiceId = String(rnvSession.voice_id);
      connectBackendEvents();
      await applyReturnIdle();
      Player.attach(rnvSession, `${rnvBase}${preset.thumbnail_url}`);
      presetPanel.hidden = true;
      chatPanel.hidden = false;
      characterName.textContent = `${preset.name}(${presetMetaText(preset)})`;
      chatLog.replaceChildren();
      setAppStatus("会話を開始できます");
    } catch (error) {
      setAppStatus(`キャラクターの復元に失敗しました: ${error.message}`, true);
    }
  }

  changeCharacter.addEventListener("click", async () => {
    if (Mic.isActive()) await toggleMic();
    if (backendEvents) backendEvents.close();
    conversationId = null;
    Player.reset();
    chatPanel.hidden = true;
    presetPanel.hidden = false;
    loadPresets();
  });

  // ROLE・話者IDをバックエンドへ同期する。「反映」ボタンのほか、
  // 各ターン送信前にも自動で呼ぶ(書いただけで反映されないと、特に音声
  // 会話ではROLEがsystemプロンプトに乗らないまま進んでしまうため)。
  async function syncSettings({announce = false} = {}) {
    if (!conversationId) return;
    const roleDirty = roleInput.value !== appliedRole;
    const voiceDirty = voiceIdInput.value !== appliedVoiceId;
    if (!roleDirty && !voiceDirty && !announce) return;
    const voiceId = parseInt(voiceIdInput.value, 10);
    const response = await fetch(`/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        role: roleDirty ? roleInput.value : null,
        voice_id: voiceDirty && Number.isFinite(voiceId) ? voiceId : null,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (roleDirty) {
      appliedRole = roleInput.value;
      if (currentPreset) saveRole(currentPreset.id, roleInput.value);
    }
    if (voiceDirty && Number.isFinite(voiceId)) appliedVoiceId = voiceIdInput.value;
    if (announce || roleDirty || voiceDirty) setAppStatus("ROLEと話者IDを反映しました");
  }

  // 話し終わり→待機のつなぎ方(r-n-vの turn_end_mode)。連続性優先(return_idle)か
  // 動きの勢い優先(free)かは好みが分かれるため、フロントで切替できるようにする。
  const RETURN_IDLE_STORAGE_KEY = "rcvReturnIdle";

  function loadReturnIdlePreference() {
    try { return (localStorage.getItem(RETURN_IDLE_STORAGE_KEY) ?? "1") === "1"; }
    catch { return true; }
  }

  async function applyReturnIdle() {
    if (!rnvSession) return;
    const wanted = returnIdleToggle.checked ? "return_idle" : "free";
    if (rnvSession.turn_end_mode === wanted) return;
    try {
      const response = await fetch(`${rnvBase}/api/sessions/${rnvSession.id}/settings`, {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({turn_end_mode: wanted}),
      });
      if (response.ok) rnvSession = await response.json();
    } catch {}
  }

  // 話し終わりの収束モーションを末尾から何秒切って待機に渡すか(好みで調整)
  const TAIL_TRIM_STORAGE_KEY = "rcvTailTrim";
  const tailTrimInput = document.getElementById("tail-trim-input");
  const tailTrimValue = document.getElementById("tail-trim-value");

  function applyTailTrim(seconds) {
    Player.setTailTrim(seconds);
    tailTrimValue.textContent = `${seconds.toFixed(1)}秒`;
  }

  {
    let stored = 0.5;
    try { stored = parseFloat(localStorage.getItem(TAIL_TRIM_STORAGE_KEY) ?? "0.5"); }
    catch {}
    if (!Number.isFinite(stored) || stored < 0 || stored > 1.5) stored = 0.5;
    tailTrimInput.value = String(stored);
    applyTailTrim(stored);
  }
  tailTrimInput.addEventListener("input", () => {
    const seconds = parseFloat(tailTrimInput.value);
    applyTailTrim(seconds);
    try { localStorage.setItem(TAIL_TRIM_STORAGE_KEY, String(seconds)); }
    catch {}
  });

  returnIdleToggle.checked = loadReturnIdlePreference();
  returnIdleToggle.addEventListener("change", () => {
    try { localStorage.setItem(RETURN_IDLE_STORAGE_KEY, returnIdleToggle.checked ? "1" : "0"); }
    catch {}
    applyReturnIdle();
  });

  applySettings.addEventListener("click", async () => {
    try {
      await syncSettings({announce: true});
    } catch (error) {
      setAppStatus(`設定の反映に失敗しました: ${error.message}`, true);
    }
  });

  roleInput.addEventListener("change", () => {
    syncSettings().catch(error =>
      setAppStatus(`設定の反映に失敗しました: ${error.message}`, true));
  });

  // --- ターン送信 --------------------------------------------------------

  chatForm.addEventListener("submit", async event => {
    event.preventDefault();
    const text = chatText.value.trim();
    if (!text || !conversationId) return;
    if (isBusy()) {
      setAppStatus("前の応答を生成中です", true);
      return;
    }
    chatText.value = "";
    try {
      await syncSettings();
      const response = await fetch(`/api/conversations/${conversationId}/text-turn`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({text}),
      });
      if (!response.ok) throw new Error((await response.json()).detail || `HTTP ${response.status}`);
    } catch (error) {
      setAppStatus(`送信に失敗しました: ${error.message}`, true);
    }
  });

  async function submitAudioSegment(audioB64) {
    if (!conversationId || isBusy()) return;
    await syncSettings();
    const response = await fetch(`/api/conversations/${conversationId}/audio-turn`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({audio_b64: audioB64, format: "wav"}),
    });
    if (!response.ok) {
      throw new Error((await response.json()).detail || `HTTP ${response.status}`);
    }
  }

  // --- マイク ------------------------------------------------------------

  async function toggleMic() {
    if (Mic.isActive()) {
      await Mic.stop();
      micToggle.textContent = "マイクON";
      micToggle.classList.remove("on");
      return;
    }
    try {
      await Mic.start({
        onSegment: submitAudioSegment,
        onStatus: text => { micStatus.textContent = text; },
        onLevel: (level, active) => {
          micLevel.style.width = `${Math.min(100, level * 900)}%`;
          micLevel.classList.toggle("active", active);
        },
        isBusy,
      });
      micToggle.textContent = "マイクOFF";
      micToggle.classList.add("on");
    } catch (error) {
      micStatus.textContent = `マイクを開始できませんでした: ${error.message}`;
    }
  }

  micToggle.addEventListener("click", toggleMic);

  // --- マイク感度 --------------------------------------------------------
  // スライダは「感度」なので右ほど敏感=しきい値は小さい。音量は対数的に
  // 感じるため、目盛りも対数で割り当てる(線形だと左端付近だけで効きすぎる)。
  const MIC_THRESHOLD_STORAGE_KEY = "chara-chat/mic-threshold";
  const THRESHOLD_AT_MIN_SENS = 0.08;   // スライダ左端: 大声だけ拾う
  const THRESHOLD_AT_MAX_SENS = 0.002;  // スライダ右端: ささやき声でも拾う
  const THRESHOLD_RANGE = THRESHOLD_AT_MIN_SENS / THRESHOLD_AT_MAX_SENS;

  const micSensitivity = document.getElementById("mic-sensitivity");
  const micSensitivityValue = document.getElementById("mic-sensitivity-value");
  const micThresholdMark = document.getElementById("mic-threshold");

  const sliderToThreshold = value =>
    THRESHOLD_AT_MAX_SENS * Math.pow(THRESHOLD_RANGE, (100 - value) / 100);
  const thresholdToSlider = threshold =>
    100 - 100 * Math.log(threshold / THRESHOLD_AT_MAX_SENS) / Math.log(THRESHOLD_RANGE);

  function applyMicThreshold(threshold, {save = true} = {}) {
    Mic.setThreshold(threshold);
    micSensitivityValue.textContent = threshold.toFixed(3);
    // メーターと同じ換算(level*900%)で判定ラインを置く
    micThresholdMark.style.left = `${Math.min(100, threshold * 900)}%`;
    if (!save) return;
    try { localStorage.setItem(MIC_THRESHOLD_STORAGE_KEY, threshold.toFixed(4)); }
    catch {}
  }

  micSensitivity.addEventListener("input", () =>
    applyMicThreshold(sliderToThreshold(Number(micSensitivity.value))));

  function restoreMicThreshold() {
    let threshold = Mic.DEFAULT_THRESHOLD;
    try {
      const saved = parseFloat(localStorage.getItem(MIC_THRESHOLD_STORAGE_KEY));
      if (Number.isFinite(saved)) threshold = saved;
    } catch {}
    const position = Math.round(thresholdToSlider(
      Math.min(THRESHOLD_AT_MIN_SENS, Math.max(THRESHOLD_AT_MAX_SENS, threshold))));
    micSensitivity.value = String(position);
    // スライダ位置から引き直して、表示とつまみの位置をずらさない
    applyMicThreshold(sliderToThreshold(position), {save: false});
  }

  restoreMicThreshold();

  // --- 初期化 ------------------------------------------------------------

  async function boot() {
    const config = await fetch("/api/config").then(r => r.json());
    rnvBase = config.narration_url;
    Player.init({
      rnvBase,
      onStatus: (text, error) => {
        stageStatus.textContent = error ? `${text}: ${error}` : text;
        stageStatus.classList.toggle("error", Boolean(error));
      },
    });
    loadPresets();
  }

  boot();

  // --- 会話ログの保存(txt) ---
  saveLogButton.addEventListener("click", () => {
    const lines = [...chatLog.querySelectorAll(".bubble")].map((b) => {
      const who = b.classList.contains("user") ? "あなた" : (currentPreset?.name || "キャラ");
      return `${who}: ${b.textContent}`;
    });
    const name = `chara-chat_${(currentPreset?.name || "log")}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // --- D&D: 枠外ドロップでのページ遷移防止 + ROLE欄への .txt ドロップ ---
  ["dragover", "drop"].forEach((type) =>
    window.addEventListener(type, (event) => event.preventDefault()));

  roleInput.addEventListener("drop", async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.txt$/i.test(file.name) && file.type && file.type !== "text/plain") return;
    try {
      roleInput.value = (await file.text()).trim();
      roleInput.dispatchEvent(new Event("input"));
    } catch {}
  });

})();
