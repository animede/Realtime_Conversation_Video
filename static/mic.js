// マイク入力: 発話区切り(VAD)とフィルタ。AI-chara static/studio.js からの移植。
// energy(RMS)+ZCR のハイブリッドVAD、BPF 250-4000Hz、プリロール6フレーム、
// 無音900msで区切り、260ms未満の短い区切りは捨てる。出力は WAV(PCM16 mono)。
const MIC_PROCESSOR_BUFFER_SIZE = 4096;
const MIC_PRE_ROLL_FRAMES = 6;
const MIC_SPEECH_THRESHOLD_DEFAULT = 0.018;
const MIC_BPF_HPF_FREQ = 250;
const MIC_BPF_LPF_FREQ = 4000;
const MIC_ZCR_MIN = 0.008;
const MIC_ZCR_MAX = 0.22;
const MIC_SILENCE_HOLD_MS = 900;
const MIC_MIN_SPEECH_MS = 260;
const MIC_WARMUP_MS = 800;

const Mic = (() => {
  // 発話開始とみなすRMSしきい値。UIのスライダから実行中でも変更できる
  // (小さいほど敏感)。マイクONのまま動かしても次のフレームから効く。
  let speechThreshold = MIC_SPEECH_THRESHOLD_DEFAULT;
  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let monitorGainNode = null;
  let captureActive = false;
  let segmentActive = false;
  let segmentSending = false;
  let preRollBuffers = [];
  let segmentBuffers = [];
  let lastSpeechAt = 0;
  let speechStartedAt = 0;
  let warmupUntil = 0;
  let callbacks = {};

  function status(text) {
    if (callbacks.onStatus) callbacks.onStatus(text);
  }

  function computeAudioLevel(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    return Math.sqrt(sum / Math.max(1, frame.length));
  }

  function computeZeroCrossingRate(frame) {
    let count = 0;
    for (let i = 1; i < frame.length; i += 1) {
      if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) count += 1;
    }
    return count / Math.max(1, frame.length);
  }

  function isVoiceFrameByZcr(frame) {
    const zcr = computeZeroCrossingRate(frame);
    return zcr >= MIC_ZCR_MIN && zcr <= MIC_ZCR_MAX;
  }

  function resetSegmentState() {
    segmentActive = false;
    segmentBuffers = [];
    preRollBuffers = [];
  }

  function handleAudioProcess(event) {
    if (!captureActive || segmentSending) return;

    // キャラの発話中・返答生成中は取り込まない(自分の声の拾い直し防止)。
    if (callbacks.isBusy && callbacks.isBusy()) {
      resetSegmentState();
      status("応答の生成・再生中はマイク入力を待機します。");
      return;
    }

    const inputData = event.inputBuffer.getChannelData(0);
    const frame = new Float32Array(inputData.length);
    frame.set(inputData);
    const now = Date.now();
    const level = computeAudioLevel(frame);
    if (callbacks.onLevel) callbacks.onLevel(level, segmentActive);

    preRollBuffers.push(frame);
    if (preRollBuffers.length > MIC_PRE_ROLL_FRAMES) preRollBuffers.shift();

    if (!segmentActive) {
      if (now < warmupUntil || level < speechThreshold) {
        status("マイクON。話し始めると自動で録音します。");
        return;
      }
      if (!isVoiceFrameByZcr(frame)) return;
      segmentActive = true;
      speechStartedAt = now;
      lastSpeechAt = now;
      // プリロールで発話の頭切れを補償する
      segmentBuffers = preRollBuffers.slice();
      preRollBuffers = [];
      status("発話を検出中。無音で自動送信します。");
      return;
    }

    segmentBuffers.push(frame);
    if (level >= speechThreshold && isVoiceFrameByZcr(frame)) {
      lastSpeechAt = now;
      return;
    }
    if (now - lastSpeechAt < MIC_SILENCE_HOLD_MS) return;

    const buffers = segmentBuffers.slice();
    const sampleRate = audioContext ? audioContext.sampleRate : 24000;
    const speechDurationMs = now - speechStartedAt;
    resetSegmentState();

    if (speechDurationMs < MIC_MIN_SPEECH_MS || !buffers.length) {
      status("マイクON。話し始めると自動で録音します。");
      return;
    }
    submitSegment(buffers, sampleRate);
  }

  async function submitSegment(buffers, sampleRate) {
    segmentSending = true;
    status("音声入力を取り込み中です。");
    try {
      const wavBuffer = encodeWavBuffer(buffers, sampleRate);
      await callbacks.onSegment(arrayBufferToBase64(wavBuffer));
    } catch (error) {
      status(`音声入力の送信に失敗しました: ${error.message}`);
    } finally {
      segmentSending = false;
    }
  }

  function mergeAudioFrames(buffers) {
    const totalLength = buffers.reduce((sum, frame) => sum + frame.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const frame of buffers) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    return merged;
  }

  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function encodeWavBuffer(buffers, sampleRate) {
    const samples = mergeAudioFrames(buffers);
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
    return buffer;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  async function start(options) {
    callbacks = options;
    status("マイクを準備中です。");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
      video: false,
    });
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextCtor();
    await audioContext.resume();
    sourceNode = audioContext.createMediaStreamSource(stream);
    processorNode = audioContext.createScriptProcessor(MIC_PROCESSOR_BUFFER_SIZE, 1, 1);
    monitorGainNode = audioContext.createGain();
    monitorGainNode.gain.value = 0;
    preRollBuffers = [];
    segmentBuffers = [];
    processorNode.onaudioprocess = handleAudioProcess;
    // 人間の声の帯域(250-4000Hz)だけを通すバンドパス
    const hpfNode = audioContext.createBiquadFilter();
    hpfNode.type = "highpass";
    hpfNode.frequency.value = MIC_BPF_HPF_FREQ;
    hpfNode.Q.value = 0.7;
    const lpfNode = audioContext.createBiquadFilter();
    lpfNode.type = "lowpass";
    lpfNode.frequency.value = MIC_BPF_LPF_FREQ;
    lpfNode.Q.value = 0.7;
    sourceNode.connect(hpfNode);
    hpfNode.connect(lpfNode);
    lpfNode.connect(processorNode);
    // ScriptProcessorはdestinationに繋がないと発火しないブラウザがあるため無音で接続
    processorNode.connect(monitorGainNode);
    monitorGainNode.connect(audioContext.destination);
    captureActive = true;
    segmentActive = false;
    warmupUntil = Date.now() + MIC_WARMUP_MS;
    status("マイクON。話し始めると自動で録音します。");
  }

  async function stop() {
    if (processorNode) {
      processorNode.onaudioprocess = null;
      try { processorNode.disconnect(); } catch {}
    }
    if (monitorGainNode) { try { monitorGainNode.disconnect(); } catch {} }
    if (sourceNode) { try { sourceNode.disconnect(); } catch {} }
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (audioContext) await audioContext.close().catch(() => {});
    stream = null;
    audioContext = null;
    sourceNode = null;
    processorNode = null;
    monitorGainNode = null;
    captureActive = false;
    resetSegmentState();
    if (callbacks.onLevel) callbacks.onLevel(0, false);
    status("マイクOFF");
  }

  return {
    start,
    stop,
    isActive: () => captureActive,
    setThreshold: value => { speechThreshold = value; },
    getThreshold: () => speechThreshold,
    DEFAULT_THRESHOLD: MIC_SPEECH_THRESHOLD_DEFAULT,
  };
})();
