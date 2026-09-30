// キャラ映像プレーヤ: realtime-narration-video の app.js から移植した外部GUI版。
// 待機動画プールの巡回再生+周回ごとの追い足し、SSE購読、playableチャンクの
// 順次再生(speech_duration境界で無音尾を切る)を行う。URLは全てr-n-vの
// オリジンを前置して絶対化する。
const Player = (() => {
  let rnvBase = "";
  let sessionId = null;
  let eventSource = null;
  let latestSession = null;
  let onStatus = () => {};

  // 待機プール
  let idleQueue = [];
  let idleSeen = new Set();
  let idlePoolUrls = [];
  let idlePoolSize = 3;
  let currentIdleSrc = null;
  let idleShown = false;
  let idleExtendInFlight = false;
  let idleAdvances = 0;
  let idleLastExtendAdvance = -99;
  let activeIdleStage = 0;

  // チャンク再生
  let nextIndex = 0;
  let playingIndex = null;
  let preloadedIndex = null;
  let playbackStarted = false;

  let stageCharacter, stageIdle, stageIdleB, idleStages, players, caption;

  const IDLE_REFRESH_TIMEOUT_MS = 5 * 60 * 1000;
  // return_idle の最終チャンクは末尾が待機ポーズへ収束する。収束は終端近くで
  // 急激に進む(途中で切るとポーズ不一致、最後まで見せるとほぼ静止)ため、
  // 割合ではなく「終端の固定秒数だけ手前」で待機へ渡す。この区間はほぼ静止
  // なので、代わりに待機動画(微動あり)を見せた方が生きて見える。
  const TAIL_TRIM_SECONDS = 0.5;
  let lastUserActivity = Date.now();

  function absolute(url) {
    return url && url.startsWith("/") ? rnvBase + url : url;
  }

  function bindElements() {
    stageCharacter = document.getElementById("stage-character");
    stageIdle = document.getElementById("stage-idle-a");
    stageIdleB = document.getElementById("stage-idle-b");
    idleStages = [stageIdle, stageIdleB];
    players = [document.getElementById("player-a"), document.getElementById("player-b")];
    caption = document.getElementById("caption");

    idleStages.forEach(media => media.addEventListener("ended", advanceIdle));

    players.forEach(player => player.addEventListener("ended", () => {
      if (player !== players[activePlayer]) return;
      if (playingIndex === null) return;
      nextIndex = playingIndex + 1;
      playingIndex = null;
      if (latestSession) {
        playNext(latestSession.chunks);
        if (playingIndex === null) showIdleStage();
        restoreCharacterAfterTurn(latestSession);
      }
    }));
    players.forEach(player => player.addEventListener("timeupdate", () => {
      if (player === players[activePlayer] && latestSession) {
        advanceAfterSpeech(latestSession.chunks);
      }
    }));
    players.forEach(player => player.addEventListener("playing", () => {
      if (player === players[activePlayer]) hideIdleStage();
      if (tapToPlay) tapToPlay.hidden = true;
    }));
    idleStages.forEach(media => media.addEventListener("transitionend", () => {
      if (!media.classList.contains("visible")) {
        media.hidden = true;
        media.pause();
      }
    }));

    ["pointerdown", "keydown"].forEach(type =>
      document.addEventListener(type, () => {
        lastUserActivity = Date.now();
        maybeExtendIdlePool();
      }, {passive: true}));
    document.addEventListener("visibilitychange", () => {
      // 非表示タブが待機映像の追い生成でGPUを回し続けないようにする
      if (document.hidden) {
        if (idleShown) idleStages[activeIdleStage].pause();
      } else if (idleShown) {
        lastUserActivity = Date.now();
        idleStages[activeIdleStage].play().catch(() => {});
      }
    });

    // 再生の番犬。ブラウザは映像を勝手に止めることがあり、止まったまま放置すると
    // ended が来ず再生機構全体が凍結して見える。実測した2経路に対処する:
    // 1) Chromeが背面・遮蔽扱いのタブ(埋め込みプレビューはdocument.hidden=trueの
    //    まま表示される)で無音動画を省電力停止し、play()もAbortErrorで拒否する
    // 2) 音声付きチャンクが自動再生ポリシーでNotAllowedErrorになる(別オリジンの
    //    ため r-n-v で許可済みでも引き継がれない)— この場合はリトライでは復帰
    //    できないので「タップで再生」を出し、クリック(ユーザー操作)で再生する
    setInterval(() => {
      if (playingIndex !== null) {
        const player = players[activePlayer];
        if (player.paused && !player.ended) {
          player.play().catch(err => {
            if (err && err.name === "NotAllowedError") showTapToPlay();
          });
        }
        return;
      }
      if (!idleShown) return;
      const active = idleStages[activeIdleStage];
      if (active.getAttribute("src") && active.paused) {
        active.play().catch(() => {});
      }
    }, 1500);

    tapToPlay = document.getElementById("tap-to-play");
    tapToPlay.addEventListener("click", () => {
      tapToPlay.hidden = true;
      // クリック=ユーザー操作の文脈なので自動再生制限がかからない
      if (playingIndex !== null) {
        players[activePlayer].play().catch(() => {});
      } else {
        showIdleStage();
      }
    });
  }

  let tapToPlay = null;

  function showTapToPlay() {
    if (tapToPlay) tapToPlay.hidden = false;
  }

  let activePlayer = 0;

  // --- 待機プール --------------------------------------------------------

  function absorbIdlePool(session) {
    (session.idle_videos || []).forEach(url => {
      if (!idleSeen.has(url)) {
        idleSeen.add(url);
        idleQueue.push(`${absolute(url)}?t=${session.idle_video_ready_at || Date.now()}`);
      }
    });
    if (session.idle_videos && session.idle_videos.length) {
      const stamp = session.idle_video_ready_at || Date.now();
      idlePoolUrls = session.idle_videos.map(url => `${absolute(url)}?t=${stamp}`);
    }
    if (session.idle_pool_size) idlePoolSize = session.idle_pool_size;
  }

  function maybeExtendIdlePool() {
    // プール1周につき1本だけリフレッシュ(GPUを回しすぎない)。
    if (!sessionId || idleExtendInFlight) return;
    if (document.hidden) return;
    if (Date.now() - lastUserActivity > IDLE_REFRESH_TIMEOUT_MS) return;
    if (idleAdvances - idleLastExtendAdvance < idlePoolSize) return;
    idleLastExtendAdvance = idleAdvances;
    idleExtendInFlight = true;
    // キャラ切替後に旧セッションの応答が届くと旧キャラの待機動画が混入するため、
    // 応答時点でセッションが変わっていたら捨てる
    const requestSessionId = sessionId;
    fetch(`${rnvBase}/api/sessions/${requestSessionId}/idle-pool`, {method: "POST"})
      .then(async response => {
        const data = await response.json();
        if (response.ok && sessionId === requestSessionId) absorbIdlePool(data);
      })
      .catch(() => {})
      .finally(() => {
        if (sessionId === requestSessionId) idleExtendInFlight = false;
      });
  }

  function preloadNextIdle() {
    const upcoming = idleQueue[0];
    if (!upcoming) return;
    const standby = idleStages[1 - activeIdleStage];
    if (standby.getAttribute("src") !== upcoming) {
      standby.src = upcoming;
      standby.load();
    }
  }

  function swapIdleTo(src) {
    const incoming = idleStages[1 - activeIdleStage];
    const outgoing = idleStages[activeIdleStage];
    currentIdleSrc = src;
    if (incoming.getAttribute("src") !== src) {
      incoming.src = src;
      incoming.load();
    }
    incoming.hidden = false;
    const start = () => {
      if (!idleShown) return;
      // 全クリップ同ポーズ始終なのでフェードなしの瞬時切替が最も自然
      incoming.style.zIndex = "4";
      outgoing.style.zIndex = "3";
      incoming.style.transition = "none";
      incoming.play().catch(() => {});
      incoming.classList.add("visible");
      void incoming.offsetWidth;
      incoming.style.transition = "";
      outgoing.classList.remove("visible");
      activeIdleStage = idleStages.indexOf(incoming);
      preloadNextIdle();
    };
    if (incoming.readyState >= 2) start();
    else incoming.addEventListener("canplay", start, {once: true});
  }

  function startIdlePlayback() {
    const next = idleQueue.shift() || currentIdleSrc;
    if (next) swapIdleTo(next);
    maybeExtendIdlePool();
    preloadNextIdle();
  }

  function advanceIdle() {
    if (!idleShown) return;
    idleAdvances += 1;
    if (idleQueue.length === 0 && idlePoolUrls.length) {
      idleQueue = idlePoolUrls.filter(src => src !== currentIdleSrc);
      if (idlePoolUrls.length > 5) {
        for (let i = idleQueue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [idleQueue[i], idleQueue[j]] = [idleQueue[j], idleQueue[i]];
        }
      }
    }
    maybeExtendIdlePool();
    const next = idleQueue.shift();
    if (next) {
      swapIdleTo(next);
    } else {
      const active = idleStages[activeIdleStage];
      active.currentTime = 0;
      active.play().catch(() => {});
    }
  }

  function showIdleStage() {
    const active = idleStages[activeIdleStage];
    const hasIdleVideo = Boolean(active.getAttribute("src")) || idleQueue.length > 0;
    stageCharacter.hidden = hasIdleVideo;
    stageCharacter.classList.toggle("visible", !hasIdleVideo);
    idleShown = hasIdleVideo;
    if (!hasIdleVideo) return;
    if (!active.getAttribute("src")) {
      startIdlePlayback();
      return;
    }
    active.hidden = false;
    if (!active.classList.contains("visible") && active.readyState > 0) {
      active.currentTime = 0;
    }
    active.classList.add("visible");
    active.play().catch(() => {});
  }

  function hideIdleStage() {
    idleShown = false;
    stageCharacter.classList.remove("visible");
    idleStages.forEach(media => media.classList.remove("visible"));
  }

  // --- チャンク再生 ------------------------------------------------------

  function loadPlayer(player, chunk) {
    const url = `${absolute(chunk.video_url)}?t=${chunk.video_ready_at || Date.now()}`;
    if (player.dataset.chunkIndex !== String(chunk.index)) {
      player.src = url;
      player.dataset.chunkIndex = String(chunk.index);
      player.load();
    }
  }

  function playNext(chunks) {
    const chunk = chunks.find(item => item.index === nextIndex && item.status === "playable");
    if (!chunk) return;
    let targetPlayer = activePlayer;
    if (preloadedIndex === chunk.index) targetPlayer = 1 - activePlayer;
    const player = players[targetPlayer];
    const outgoing = players[activePlayer];
    loadPlayer(player, chunk);
    // opacityのクロスフェードは両方が半透明になる瞬間に背景が透けて明滅する。
    // かといって2枚を不透明のまま重ねると合成レイヤの組み替えでティアリング
    // 状の横ズレが出る。そこで新側の最初のフレームが実際に描画された瞬間に、
    // フェードなしで旧→新を同時に入れ替える(重なり期間ゼロ)。
    if (player !== outgoing) {
      const swap = () => {
        player.style.transition = "none";
        outgoing.style.transition = "none";
        player.classList.add("active");
        outgoing.classList.remove("active");
        void player.offsetWidth;
        player.style.transition = "";
        outgoing.style.transition = "";
      };
      if (player.requestVideoFrameCallback) {
        player.requestVideoFrameCallback(swap);
      } else {
        player.addEventListener("playing", swap, {once: true});
      }
    } else {
      player.classList.add("active");
    }
    activePlayer = targetPlayer;
    preloadedIndex = null;
    playingIndex = chunk.index;
    caption.textContent = chunk.text;
    player.play().catch(err => {
      onStatus("クリックすると再生が始まります");
      if (err && err.name === "NotAllowedError") showTapToPlay();
    });
    preloadFollowing(chunks);
  }

  function preloadFollowing(chunks) {
    if (playingIndex === null) return;
    const wanted = playingIndex + 1;
    const chunk = chunks.find(item => item.index === wanted && item.status === "playable");
    if (!chunk || preloadedIndex === wanted) return;
    loadPlayer(players[1 - activePlayer], chunk);
    preloadedIndex = wanted;
  }

  function advanceAfterSpeech(chunks) {
    if (playingIndex === null) return;
    const current = chunks.find(item => item.index === playingIndex);
    const player = players[activePlayer];
    // return_idle では最終チャンクの末尾が待機ポーズへFLF錨止めされている。
    // 錨止めの収束区間(無音尾)は終端に近づくほど動きが減衰して静止に見える。
    // 早く切るほどつながりが悪く、遅く切るほど止まって見える綱引きなので、
    // 無音尾の途中(TAIL_PLAY_RATIO)で待機へ切り替える。0=語尾で即切り(旧動作)、
    // 1=末尾まで再生。
    if (!current?.speech_duration) return;
    let cutAt = current.speech_duration;
    if (current.turn_final && latestSession?.turn_end_mode === "return_idle" && current.duration) {
      cutAt = Math.max(current.speech_duration, current.duration - TAIL_TRIM_SECONDS);
    }
    if (player.currentTime < cutAt) return;
    // LTXクリップは固定尺で、短い発話は無音でパディングされる。
    // 実音声の境界で止め、無音尾は待機ループが隠す。
    player.pause();
    nextIndex = playingIndex + 1;
    playingIndex = null;
    const following = chunks.find(item => item.index === nextIndex && item.status === "playable");
    if (following) {
      playNext(chunks);
    } else {
      showIdleStage();
    }
  }

  function restoreCharacterAfterTurn(session) {
    if (session.status !== "completed" || playingIndex !== null || nextIndex < session.chunks.length) return;
    showIdleStage();
  }

  // --- セッション購読 ----------------------------------------------------

  const STATUS_LABELS = {
    queued: "待機中", preparing: "キャラクター準備中", chatting: "応答を受信中",
    synthesizing: "音声を合成中", generating: "映像を生成中", playable: "再生可能",
    completed: "待機中", failed: "エラー", cancelled: "中断",
  };

  function processSession(session) {
    latestSession = session;
    absorbIdlePool(session);
    onStatus(STATUS_LABELS[session.status] || session.status,
             session.error ? String(session.error) : "");
    const readyChunks = session.chunks.filter(
      chunk => chunk.status === "playable" && chunk.index >= nextIndex);
    if (!playbackStarted && readyChunks.length) {
      loadPlayer(players[activePlayer], readyChunks[0]);
    }
    const enoughCount = readyChunks.length >=
      Math.min(session.startup_buffer_chunks, session.chunks.length);
    if (!playbackStarted && readyChunks.length && enoughCount) {
      playbackStarted = true;
      playNext(session.chunks);
    } else if (playbackStarted && playingIndex === null) {
      playNext(session.chunks);
    }
    preloadFollowing(session.chunks);
    advanceAfterSpeech(session.chunks);
    if (playingIndex === null && !readyChunks.length && session.character_prepared) {
      showIdleStage();
    }
    restoreCharacterAfterTurn(session);
  }

  function connectEvents() {
    if (eventSource) eventSource.close();
    // SSEは常時接続を維持する(視聴者ゼロが5秒続くとサーバがターンを中断する)
    eventSource = new EventSource(`${rnvBase}/api/sessions/${sessionId}/events`);
    eventSource.addEventListener("session", event => processSession(JSON.parse(event.data)));
  }

  function reset() {
    if (eventSource) eventSource.close();
    eventSource = null;
    latestSession = null;
    idleQueue = [];
    idleSeen = new Set();
    idlePoolUrls = [];
    currentIdleSrc = null;
    idleShown = false;
    idleExtendInFlight = false;
    idleAdvances = 0;
    idleLastExtendAdvance = -99;
    nextIndex = 0;
    playingIndex = null;
    preloadedIndex = null;
    playbackStarted = false;
    idleStages.forEach(media => {
      media.pause();
      media.classList.remove("visible");
      media.removeAttribute("src");
      media.load();
      media.hidden = true;
    });
    players.forEach(player => {
      player.pause();
      player.classList.remove("active");
      player.style.zIndex = "";
      player.removeAttribute("src");
      delete player.dataset.chunkIndex;
      player.load();
    });
    activeIdleStage = 0;
    activePlayer = 0;
    caption.textContent = "";
  }

  function init(options) {
    rnvBase = options.rnvBase;
    onStatus = options.onStatus || (() => {});
    bindElements();
  }

  function attach(session, thumbnailUrl) {
    reset();
    sessionId = session.id;
    stageCharacter.src = thumbnailUrl;
    nextIndex = session.chunks.length;  // 復元直後の既存チャンクは再生対象にしない
    processSession(session);
    connectEvents();
  }

  function isSpeaking() {
    if (playingIndex !== null) return true;
    if (!latestSession) return false;
    return ["chatting", "synthesizing", "generating", "playable"].includes(latestSession.status);
  }

  return {init, attach, reset, isSpeaking, session: () => latestSession};
})();
