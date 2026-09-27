// ステージとチャット欄の幅配分: スプリッタのドラッグで変更し、localStorageに残す。
(() => {
  // 既定幅を変えても保存値が勝つため、既定を変えたらキーも上げて一度だけ捨てる
  const STORAGE_KEY = "chara-chat/side-width/v3";
  const DEFAULT_WIDTH = 230;
  const MIN_SIDE = 200;   // チャット欄がこれ以下だと吹き出しが読めない
  const MIN_STAGE = 320;  // ステージを潰し切らないための下限

  const layout = document.querySelector(".layout");
  const stageColumn = document.querySelector(".stage-column");
  const sideColumn = document.querySelector(".side-column");
  const splitter = document.getElementById("splitter");

  // ユーザが指定した幅。画面が狭いときは表示だけclampし、この値は保つ
  // (ウィンドウを戻したら元の幅に復帰させるため)。
  let desiredWidth = DEFAULT_WIDTH;
  try {
    const saved = parseFloat(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved)) desiredWidth = saved;
  } catch {}

  function render() {
    // 2列で分け合える幅。padding・gap・スプリッタ列を除いた実寸なので、
    // layout.clientWidth から引き算するより確実(スクロールバーの有無も込み)。
    const available = stageColumn.getBoundingClientRect().width
      + sideColumn.getBoundingClientRect().width;
    const max = Math.max(MIN_SIDE, available - MIN_STAGE);
    const width = Math.min(Math.max(desiredWidth, MIN_SIDE), max);
    layout.style.setProperty("--side-width", `${Math.round(width)}px`);
  }

  function setWidth(width) {
    desiredWidth = width;
    render();
    try { localStorage.setItem(STORAGE_KEY, String(Math.round(width))); }
    catch {}
  }

  let activePointer = null;
  let startX = 0;
  let startWidth = 0;

  splitter.addEventListener("pointerdown", event => {
    event.preventDefault();
    activePointer = event.pointerId;
    startX = event.clientX;
    startWidth = sideColumn.getBoundingClientRect().width;
    // 捕捉できればカーソルが外れてもドラッグが続く。失敗してもwindow側で拾う
    try { splitter.setPointerCapture(event.pointerId); } catch {}
    splitter.classList.add("dragging");
  });

  window.addEventListener("pointermove", event => {
    if (activePointer !== event.pointerId) return;
    // 左に動かすほどサイド幅は広がる
    setWidth(startWidth - (event.clientX - startX));
  });

  const endDrag = event => {
    if (activePointer !== event.pointerId) return;
    activePointer = null;
    splitter.classList.remove("dragging");
  };
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  splitter.addEventListener("dblclick", () => setWidth(DEFAULT_WIDTH));

  window.addEventListener("resize", render);
  render();
})();
