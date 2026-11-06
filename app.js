/* Teleprompter — real speech-following teleprompter
   Voice tracking: Web Speech API (webkitSpeechRecognition on iOS Safari).
   Matching: word-level Levenshtein against a forward window of the script.
   No timers pretend to follow you: in voice mode the scroll only moves when
   words are actually recognised. A separate manual (constant-speed) mode is
   clearly labelled as manual. */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);

  const els = {
    stage: $("#stage"),
    script: $("#script"),
    status: $("#status"),
    topbar: $("#topbar"),
    hud: $("#hud"),
    settings: $("#settings"),
    play: $("#btn-play"),
    pause: $("#btn-pause"),
    stop: $("#btn-stop"),
    more: $("#btn-more"),
    edit: $("#btn-edit"),
    focus: $("#btn-focus"),
    editor: $("#editor"),
    edText: $("#ed-text"),
    edSave: $("#ed-save"),
    edCancel: $("#ed-cancel"),
    edCount: $("#ed-count"),
    toast: $("#toast"),
    sheet: $("#sheet"),
    sheetTitle: $("#sheet-title"),
    sheetBody: $("#sheet-body"),
    sheetOk: $("#sheet-ok"),
    rngSpeed: $("#rng-speed"),
    lblSpeed: $("#lbl-speed"),
    lblFont: $("#lbl-font"),
    selLang: $("#sel-lang"),
    modeVoice: $("#btn-mode-voice"),
    note: $("#pwa-note"),
    noteClose: $("#pwa-note-close"),
    noteCopy: $("#pwa-note-copy"),
    noteText: $("#pwa-note-text"),
    modeManual: $("#btn-mode-manual"),
  };

  const DEFAULTS = {
    speed: 45,
    font: 44,
    lang: "en-US",
    mode: "voice",
  };

  const DEMO = [
    "Good morning everyone, and thank you for being here today.",
    "",
    "I want to start with one number: forty pounds a day. That is the goal I set for myself, and it changed the way I work.",
    "",
    "In the next few minutes I will show you what I built, why it matters, and what I learned along the way.",
  ].join("\n");

  const SpeechRecognitionCtor =
    typeof window.SpeechRecognition !== "undefined"
      ? window.SpeechRecognition
      : typeof window.webkitSpeechRecognition !== "undefined"
        ? window.webkitSpeechRecognition
        : null;

  const state = {
    words: [],        // { el, n (normalised or "" for hints) }
    idx: -1,          // index of the last word actually matched
    running: false,   // prompter playing
    paused: false,
    listening: false, // recogniser wants audio
    mode: DEFAULTS.mode,
    speed: DEFAULTS.speed,
    font: DEFAULTS.font,
    lang: DEFAULTS.lang,
    finalBuf: "",
    interim: "",
    targetY: 0,
    userHoldUntil: 0,
    retries: 0,
    lastError: "",
    gotAnyResult: false,
  };

  /* ------------------------------------------------------------------ */
  /* text handling                                                       */
  /* ------------------------------------------------------------------ */

  function normalise(word) {
    return word
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^\p{L}\p{N}']/gu, "")
      .replace(/^'+|'+$/g, "");
  }

  // normalise word-by-word: normalise() strips punctuation *and* spaces, so it
  // must never be applied to a whole sentence.
  function wordsOf(text) {
    return text.split(/\s+/).map(normalise).filter(Boolean);
  }

  function tokenise(text) {
    // Drop inline hints like [look at camera] from matching, keep them visible.
    const blocks = text.split(/\n{2,}/);
    const out = [];
    blocks.forEach((block, bi) => {
      if (bi > 0) out.push({ br: true });
      const parts = block.split(/(\[[^\]]*\])/g);
      parts.forEach((part) => {
        if (!part) return;
        if (part.startsWith("[") && part.endsWith("]")) {
          part.split(/\s+/).filter(Boolean).forEach((w) => {
            out.push({ t: w, n: "", hint: true });
          });
          return;
        }
        part.split(/\s+/).filter(Boolean).forEach((w) => {
          out.push({ t: w, n: normalise(w) });
        });
      });
    });
    return out;
  }

  function render(text) {
    els.script.textContent = "";
    const frag = document.createDocumentFragment();
    let block = document.createElement("div");
    block.className = "block";
    state.words = [];

    tokenise(text).forEach((tok) => {
      if (tok.br) {
        frag.appendChild(block);
        block = document.createElement("div");
        block.className = "block";
        return;
      }
      const span = document.createElement("span");
      span.className = "w" + (tok.hint ? " hint" : "");
      span.textContent = tok.t + " ";
      if (tok.hint) span.style.opacity = "0.45";
      const index = state.words.length;
      span.dataset.i = String(index);
      block.appendChild(span);
      state.words.push({ el: span, n: tok.n });
    });

    frag.appendChild(block);
    els.script.appendChild(frag);
    state.idx = -1;
    state.finalBuf = "";
    state.interim = "";
    state.targetY = 0;
    window.scrollTo(0, 0);
  }

  function matchedCount() {
    return state.words.filter((w) => w.n).length;
  }

  /* ------------------------------------------------------------------ */
  /* matching                                                            */
  /* ------------------------------------------------------------------ */

  function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev;
      prev = cur;
      cur = tmp;
    }
    return prev[n];
  }

  function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    const d = levenshtein(a, b);
    return 1 - d / Math.max(a.length, b.length);
  }

  function refTail(endIndex, len) {
    const out = [];
    for (let i = endIndex; i >= 0 && out.length < len; i--) {
      const n = state.words[i].n;
      if (n) out.unshift(n);
    }
    return out;
  }

  // Find where the spoken tail most plausibly ends in the script.
  function locate(spoken) {
    const total = state.words.length;
    if (!total || !spoken.length) return -1;

    const tail = spoken.slice(-12);
    const from = Math.max(0, state.idx - 8);
    const to = Math.min(total - 1, state.idx + 80);

    let bestIndex = -1;
    let bestScore = 0;

    for (let end = from; end <= to; end++) {
      if (!state.words[end].n) continue;
      const len = Math.min(tail.length, 10);
      const ref = refTail(end, len);
      if (ref.length < Math.max(2, Math.ceil(len * 0.6))) continue;
      const score = similarity(tail.slice(-len), ref);
      if (score > bestScore + 1e-9) {
        bestScore = score;
        bestIndex = end;
      }
    }

    const needed = tail.length >= 5 ? 0.55 : 0.75;
    if (bestScore < needed) return -1;
    return bestIndex;
  }

  /* ------------------------------------------------------------------ */
  /* scrolling                                                           */
  /* ------------------------------------------------------------------ */

  function scrollTargetFor(index) {
    const w = state.words[index];
    if (!w) return 0;
    const rect = w.el.getBoundingClientRect();
    const absoluteTop = rect.top + window.scrollY;
    const anchor = window.innerHeight * 0.34;
    return Math.max(0, absoluteTop - anchor);
  }

  function setIndex(index, opts) {
    if (index < 0 || index >= state.words.length) return;
    if (index === state.idx) return;

    const from = Math.max(0, Math.min(state.idx, index));
    const to = Math.max(state.idx, index);
    const firstPaint = state.idx < 0;

    for (let i = firstPaint ? 0 : from; i <= to && i < state.words.length; i++) {
      const el = state.words[i].el;
      el.classList.toggle("done", i < index);
      el.classList.toggle("cur", i === index);
    }
    state.idx = index;
    state.targetY = scrollTargetFor(index);
    if (opts && opts.instant) window.scrollTo(0, state.targetY);
  }

  let rafId = 0;
  let lastFrame = 0;
  let manualCarry = 0;

  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min(64, ts - lastFrame) : 16;
    lastFrame = ts;

    if (!state.running || state.paused) return;
    if (Date.now() < state.userHoldUntil) return;

    if (state.mode === "manual" && state.running && !state.paused) {
      manualCarry += (state.speed * dt) / 1000;
      if (manualCarry >= 1) {
        const step = Math.floor(manualCarry);
        manualCarry -= step;
        window.scrollBy(0, step);
      }
      return;
    }

    const diff = state.targetY - window.scrollY;
    if (Math.abs(diff) > 0.6) {
      window.scrollBy(0, diff * 0.16);
    }
  }
  requestAnimationFrame(frame);

  ["touchstart", "wheel", "pointerdown"].forEach((evt) => {
    window.addEventListener(
      evt,
      (e) => {
        if (e.target.closest("#hud, #topbar, #editor, #sheet")) return;
        state.userHoldUntil = Date.now() + 1200;
      },
      { passive: true }
    );
  });

  /* ------------------------------------------------------------------ */
  /* speech recognition                                                  */
  /* ------------------------------------------------------------------ */

  let rec = null;
  let wantListen = false;
  let restartTimer = 0;

  function setStatus(text) {
    els.status.textContent = text;
  }

  function toast(text, ms) {
    els.toast.textContent = text;
    els.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove("show"), ms || 3200);
  }

  function primeMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.resolve(false);
    }
    return navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        return true;
      })
      .catch(() => false);
  }

  function buildRecogniser() {
    const r = new SpeechRecognitionCtor();
    r.lang = state.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      let finals = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (!res || !res[0]) continue;
        if (res.isFinal) finals += " " + res[0].transcript;
        else interim += " " + res[0].transcript;
      }
      if (finals) {
        state.finalBuf = (state.finalBuf + finals).slice(-600);
        state.retries = 0;
      }
      state.interim = interim;
      const spoken = wordsOf(state.finalBuf + " " + interim);
      if (spoken.length) {
        state.gotAnyResult = true;
        const found = locate(spoken);
        if (found >= 0 && found > state.idx) {
          setIndex(found);
          setStatus("śledzę: " + spoken.slice(-4).join(" "));
        } else if (found < 0) {
          setStatus("słyszę: " + spoken.slice(-4).join(" "));
        }
      }
    };

    r.onerror = (event) => {
      const err = event.error || "";
      state.lastError = err;
      if (err === "no-speech" || err === "aborted") return;
      if (err === "not-allowed" || err === "service-not-allowed") {
        stopSpeech(true);
        showSpeechProblem(err);
        return;
      }
      if (err === "network") {
        setStatus("brak sieci — rozpoznawanie padło");
        toast("Rozpoznawanie mowy wymaga internetu. Spróbuj ponownie.", 4200);
        return;
      }
      setStatus("błąd mowy: " + err);
    };

    r.onend = () => {
      if (!wantListen) return;
      clearTimeout(restartTimer);
      if (state.retries > 8) {
        wantListen = false;
        state.listening = false;
        setStatus("mikrofon zatrzymany");
        toast("Mikrofon przestał odpowiadać. Dotknij Start, żeby wznowić.", 4500);
        return;
      }
      const delay = [250, 700, 1500, 3000][Math.min(state.retries, 3)];
      state.retries += 1;
      restartTimer = setTimeout(() => {
        if (wantListen) safeStart();
      }, delay);
    };

    r.onstart = () => {
      setStatus("nasłuchuję…");
    };

    return r;
  }

  function safeStart() {
    if (!rec) {
      try {
        rec = buildRecogniser();
      } catch (e) {
        showSpeechProblem("ctor");
        return;
      }
    }
    try {
      rec.start();
    } catch (e) {
      if (e && e.name === "InvalidStateError") return;
      restartTimer = setTimeout(() => {
        if (wantListen) safeStart();
      }, 600);
    }
  }

  let watchdogTimer = 0;

  function startWatchdog() {
    clearInterval(watchdogTimer);
    const startedAt = Date.now();
    state.gotAnyResult = false;
    watchdogTimer = setInterval(() => {
      if (!state.listening || state.gotAnyResult) {
        clearInterval(watchdogTimer);
        return;
      }
      if (Date.now() - startedAt > 10000) {
        clearInterval(watchdogTimer);
        setStatus("brak wyników z mikrofonu");
        toast(
          "Nie słyszę mowy. Sprawdź Dyktowanie i zgodę na mikrofon, albo dotknij „?”.",
          6000
        );
      }
    }, 1000);
  }

  function startSpeech() {
    if (!SpeechRecognitionCtor) {
      showSpeechProblem("unsupported");
      return false;
    }
    wantListen = true;
    state.listening = true;
    state.retries = 0;
    // Start inside the tap gesture (iOS requires it); warm the mic permission
    // in parallel rather than awaiting it and losing the gesture.
    safeStart();
    primeMic();
    startWatchdog();
    return true;
  }

  function stopSpeech(permanent) {
    clearInterval(watchdogTimer);
    wantListen = false;
    state.listening = false;
    clearTimeout(restartTimer);
    if (rec) {
      try {
        rec.stop();
      } catch (e) {}
      if (permanent) {
        try {
          rec.abort();
        } catch (e) {}
        rec = null;
      }
    }
  }

  function resetSpeechBuffer() {
    state.finalBuf = "";
    state.interim = "";
  }

  function showSpeechProblem(kind) {
    stopPrompter();
    let title = "Mikrofon nie działa";
    let body =
      "Safari nie dał dostępu do rozpoznawania mowy. Sprawdź: Ustawienia → Safari → Mikrofon (dla tej strony), oraz Ustawienia → Ogólne → Klawiatura → Dyktowanie włączone.";
    if (kind === "unsupported") {
      title = "Ta przeglądarka nie ma rozpoznawania mowy";
      body =
        "Otwórz ten adres w Safari na iPhonie. W trybie aplikacji z ekranu głównego iOS czasem blokuje Web Speech API — wtedy otwórz tę samą stronę w Safari (karta), albo użyj natywnej apki Open Prompter (darmowej).";
    }
    if (window.navigator.standalone) {
      body +=
        " Uwaga: jesteś w trybie „z ekranu głównego”. Jeśli mowa nie startuje, otwórz link ponownie w Safari.";
    }
    openSheet(title, body);
    setStatus("mikrofon zablokowany");
  }

  /* ------------------------------------------------------------------ */
  /* transport                                                           */
  /* ------------------------------------------------------------------ */

  function startPrompter() {
    if (!state.words.length) {
      openEditor();
      return;
    }
    state.running = true;
    state.paused = false;
    state.targetY = state.idx >= 0 ? scrollTargetFor(state.idx) : 0;

    setStatus(state.mode === "voice" ? "nasłuchuję…" : "tryb ręczny");

    if (state.mode === "voice") {
      const ok = startSpeech();
      if (!ok) {
        state.running = false;
        return;
      }
    } else {
      manualCarry = 0;
      setStatus("tryb ręczny");
    }

    els.play.hidden = true;
    els.pause.hidden = false;
    els.stop.hidden = false;
    requestWakeLock();
  }

  function pausePrompter() {
    if (!state.running) return;
    state.paused = true;
    stopSpeech(false);
    setStatus("pauza");
    els.pause.hidden = true;
    els.play.hidden = false;
    els.play.textContent = "▶ Wznów";
  }

  function resumePrompter() {
    state.paused = false;
    els.play.hidden = true;
    els.pause.hidden = false;
    if (state.mode === "voice") {
      state.retries = 0;
      wantListen = true;
      state.listening = true;
      state.retries = 0;
      safeStart();
      startWatchdog();
      setStatus("nasłuchuję…");
    } else {
      manualCarry = 0;
      setStatus("tryb ręczny");
    }
    requestWakeLock();
  }

  function stopPrompter() {
    state.running = false;
    state.paused = false;
    stopSpeech(true);
    els.play.hidden = false;
    els.pause.hidden = true;
    els.stop.hidden = true;
    els.play.textContent = "▶ Start";
    setStatus("zatrzymany");
  }

  function goHome() {
    stopPrompter();
    resetSpeechBuffer();
    for (const w of state.words) {
      w.el.classList.remove("done", "cur");
    }
    state.idx = -1;
    state.targetY = 0;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function jumpTo(index, silent) {
    if (index < 0) index = 0;
    if (index >= state.words.length) index = state.words.length - 1;
    resetSpeechBuffer();
    state.idx = -1;
    setIndex(index);
    state.targetY = scrollTargetFor(index);
    window.scrollTo({ top: state.targetY, behavior: "smooth" });
    if (!silent) toast("Przeskoczono do słowa " + (index + 1));
    if (state.running && state.mode === "voice") {
      stopSpeech(false);
      state.retries = 0;
      wantListen = true;
      setTimeout(() => safeStart(), 220);
    }
  }

  /* ------------------------------------------------------------------ */
  /* wake lock / fullscreen                                              */
  /* ------------------------------------------------------------------ */

  let wakeLock = null;
  function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    navigator.wakeLock
      .request("screen")
      .then((lock) => {
        wakeLock = lock;
      })
      .catch(() => {});
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.running) requestWakeLock();
  });

  function toggleFocus() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    document.body.classList.toggle("focus");
    els.focus.textContent = document.body.classList.contains("focus")
      ? "Pokaż UI"
      : "Pełny";
  }

  /* ------------------------------------------------------------------ */
  /* editor                                                              */
  /* ------------------------------------------------------------------ */

  function openEditor() {
    stopPrompter();
    els.editor.hidden = false;
    els.edText.value = els.script.dataset.raw || "";
    updateCount();
    els.edText.focus();
  }

  function closeEditor() {
    els.editor.hidden = true;
  }

  function updateCount() {
    const n = els.edText.value.split(/\s+/).filter(Boolean).length;
    els.edCount.textContent = n + " słów · ok. " + Math.max(1, Math.round(n / 130)) + " min czytania";
  }

  function saveText() {
    const text = els.edText.value.trim();
    if (!text) {
      toast("Tekst jest pusty");
      return;
    }
    els.script.dataset.raw = text;
    localStorage.setItem("tp.text", text);
    render(text);
    closeEditor();
    stopPrompter();
    setStatus("gotowy · " + matchedCount() + " słów");
    toast("Tekst wczytany");
  }

  /* ------------------------------------------------------------------ */
  /* sheets / settings                                                   */
  /* ------------------------------------------------------------------ */

  function openSheet(title, body) {
    els.sheetTitle.textContent = title;
    els.sheetBody.innerHTML = body;
    els.sheet.hidden = false;
  }

  function closeSheet() {
    els.sheet.hidden = true;
  }

  function applyFont(size) {
    state.font = Math.max(24, Math.min(96, size));
    document.documentElement.style.setProperty("--fs", state.font + "px");
    els.lblFont.textContent = String(state.font);
    localStorage.setItem("tp.font", String(state.font));
    if (state.idx >= 0) state.targetY = scrollTargetFor(state.idx);
  }

  function applyMode(mode) {
    state.mode = mode;
    els.modeVoice.classList.toggle("on", mode === "voice");
    els.modeManual.classList.toggle("on", mode === "manual");
    localStorage.setItem("tp.mode", mode);
    if (state.running) {
      stopPrompter();
      toast(mode === "voice" ? "Tryb głosowy" : "Tryb ręczny (stała prędkość)");
    }
  }

  function setLang(lang) {
    state.lang = lang;
    localStorage.setItem("tp.lang", lang);
    if (rec) {
      try {
        rec.lang = lang;
      } catch (e) {}
    }
    if (state.running && state.mode === "voice") {
      stopSpeech(false);
      resetSpeechBuffer();
      state.retries = 0;
      wantListen = true;
      setTimeout(() => safeStart(), 250);
    }
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                              */
  /* ------------------------------------------------------------------ */

  els.play.addEventListener("click", () => {
    if (state.paused) resumePrompter();
    else startPrompter();
  });
  els.pause.addEventListener("click", pausePrompter);
  els.stop.addEventListener("click", stopPrompter);
  els.more.addEventListener("click", () => {
    els.settings.hidden = !els.settings.hidden;
    els.more.classList.toggle("on", !els.settings.hidden);
  });
  els.edit.addEventListener("click", openEditor);
  els.focus.addEventListener("click", toggleFocus);
  els.edSave.addEventListener("click", saveText);
  els.edCancel.addEventListener("click", closeEditor);
  els.edText.addEventListener("input", updateCount);
  els.sheetOk.addEventListener("click", closeSheet);
  els.noteClose.addEventListener("click", () => {
    els.note.hidden = true;
    document.body.classList.remove("has-note");
  });
  els.noteCopy.addEventListener("click", () => {
    const url = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        () => toast("Link skopiowany — wklej go w Safari"),
        () => toast(url, 8000)
      );
    } else {
      toast(url, 8000);
    }
  });

  $("#btn-font-up").addEventListener("click", () => applyFont(state.font + 4));
  $("#btn-font-down").addEventListener("click", () => applyFont(state.font - 4));
  $("#btn-home").addEventListener("click", goHome);
  $("#btn-mode-voice").addEventListener("click", () => applyMode("voice"));
  $("#btn-mode-manual").addEventListener("click", () => applyMode("manual"));
  $("#sel-lang").addEventListener("change", (e) => setLang(e.currentTarget.value));
  els.rngSpeed.addEventListener("input", (e) => {
    state.speed = parseInt(e.currentTarget.value, 10);
    els.lblSpeed.textContent = String(state.speed);
    localStorage.setItem("tp.speed", String(state.speed));
  });

  $("#btn-jump").addEventListener("click", () => {
    const value = window.prompt(
      "Numer słowa (1–" + state.words.length + ") lub fragment tekstu:",
      String(Math.max(1, state.idx + 1))
    );
    if (!value) return;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      jumpTo(parseInt(trimmed, 10) - 1);
      return;
    }
    const needle = wordsOf(trimmed);
    if (!needle.length) return;
    for (let i = 0; i < state.words.length; i++) {
      let ok = true;
      let k = i;
      for (const word of needle) {
        while (k < state.words.length && !state.words[k].n) k++;
        if (k >= state.words.length || state.words[k].n !== word) {
          ok = false;
          break;
        }
        k++;
      }
      if (ok) {
        jumpTo(i);
        return;
      }
    }
    toast("Nie znalazłem tego fragmentu");
  });

  $("#btn-help").addEventListener("click", () => {
    openSheet(
      "Jak to działa",
      "<p><b>Tryb głosowy</b> — mikrofon nasłuchuje, a tekst przewija się tylko wtedy, gdy rozpozna Twoje słowa. Dopasowanie jest odporne na przejęzyczenia i pominięte zdania.</p>" +
        "<p><b>Pauza</b> zatrzymuje mikrofon i przewijanie. <b>Dotknij słowa</b>, żeby przeskoczyć w dowolne miejsce.</p>" +
        "<p><b>iPhone:</b> Safari → Udostępnij → „Dodaj do ekranu początkowego”.</p>" +
        "<p><b>Ważne:</b> iOS nie udostępnia rozpoznawania mowy w trybie aplikacji z ekranu głównego. Ikona otwiera stronę w Safari, gdzie mikrofon działa. Jeśli mimo to mikrofon nie startuje, włącz Dyktowanie: Ustawienia → Ogólne → Klawiatura.</p>" +
        "<p><b>Alternatywa natywna:</b> darmowa apka Open Prompter (MIT) z tym samym śledzeniem mowy: <a href='https://apps.apple.com/pl/app/open-prompter/id6763611915' target='_blank' rel='noopener'>App Store</a>.</p>"
    );
  });

  // tap a word to jump
  els.script.addEventListener("click", (e) => {
    const span = e.target.closest(".w");
    if (!span) return;
    jumpTo(parseInt(span.dataset.i, 10));
  });

  document.addEventListener("keydown", (e) => {
    if (!els.editor.hidden) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!state.running) startPrompter();
      else if (state.paused) resumePrompter();
      else pausePrompter();
    }
    if (e.key === "Escape") stopPrompter();
    if (e.key === "ArrowRight") jumpTo(state.idx + 5);
    if (e.key === "ArrowLeft") jumpTo(state.idx - 5);
    if (e.key === "ArrowDown") jumpTo(state.idx + 15);
    if (e.key === "ArrowUp") jumpTo(state.idx - 15);
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  const savedText = localStorage.getItem("tp.text");
  const text = savedText && savedText.trim() ? savedText : DEMO;
  els.script.dataset.raw = text;

  state.speed = parseInt(localStorage.getItem("tp.speed") || DEFAULTS.speed, 10);
  state.font = parseInt(localStorage.getItem("tp.font") || DEFAULTS.font, 10);
  state.lang = localStorage.getItem("tp.lang") || DEFAULTS.lang;
  state.mode = localStorage.getItem("tp.mode") || DEFAULTS.mode;

  els.rngSpeed.value = String(state.speed);
  els.lblSpeed.textContent = String(state.speed);
  els.selLang.value = state.lang;
  applyFont(state.font);
  applyMode(state.mode);
  render(text);

  const standalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  const inAppBrowser = /Telegram|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter/i.test(
    navigator.userAgent
  );
  if (standalone) {
    els.note.hidden = false;
  } else if (inAppBrowser || !SpeechRecognitionCtor) {
    els.noteText.textContent =
      "Przeglądarka w aplikacji nie ma mikrofonu. Skopiuj link i otwórz go w Safari.";
    els.note.hidden = false;
  }
  document.body.classList.toggle("has-note", !els.note.hidden);

  setStatus(SpeechRecognitionCtor ? "gotowy · dotknij Start" : "brak mowy w tej przeglądarce");

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  // debug/test hook: feeds recognised words through the same code path
  window.__tp = {
    feed: (text) => {
      state.finalBuf = (state.finalBuf + " " + text).slice(-600);
      const spoken = wordsOf(state.finalBuf);
      const found = locate(spoken);
      if (found >= 0 && found > state.idx) setIndex(found);
      return { found, idx: state.idx };
    },
    state: () => ({
      idx: state.idx,
      words: state.words.length,
      matched: matchedCount(),
      mode: state.mode,
      running: state.running,
      listening: state.listening,
      supported: !!SpeechRecognitionCtor,
      targetY: state.targetY,
      scrollY: window.scrollY,
    }),
    jumpTo,
    setText: (t) => {
      els.script.dataset.raw = t;
      render(t);
    },
    locate: (t) => locate(wordsOf(t)),
    dump: () => state.words.slice(0, 10).map((w) => w.n),
    probe: (i) => ({
      rectTop: state.words[i] ? state.words[i].el.getBoundingClientRect().top : null,
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      target: i >= 0 ? scrollTargetFor(i) : null,
      docHeight: document.documentElement.scrollHeight,
    }),
  };
})();