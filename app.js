/* Morse Code — translate, play (WebAudio), flash and tap. All local. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;

  var CODE = {
    A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--",
    N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
    "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--", "/": "-..-.", "(": "-.--.", ")": "-.--.-", "&": ".-...",
    ":": "---...", ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "-": "-....-", "_": "..--.-", "\"": ".-..-.", "$": "...-..-", "@": ".--.-."
  };
  var DECODE = {}; Object.keys(CODE).forEach(function (k) { DECODE[CODE[k]] = k; });

  // Text → Morse: letters split by spaces, words by " / ". Accents are folded (é → E); unknown characters are skipped.
  function encode(text) {
    var skipped = 0;
    var words = text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[“”]/g, "\"").replace(/[‘’]/g, "'").toUpperCase()
      .split(/\s+/).filter(Boolean).map(function (w) {
        return Array.from(w).map(function (c) { if (CODE[c]) return CODE[c]; skipped++; return null; }).filter(Boolean).join(" ");
      }).filter(Boolean);
    return { morse: words.join(" / "), skipped: skipped };
  }
  // Morse → text. Accepts . - and the look-alikes • · – — _ ; words split by / or | or 2+ spaces.
  function decode(morse) {
    var bad = 0;
    var text = morse.replace(/[•·∙]/g, ".").replace(/[–—−_]/g, "-").trim()
      .split(/\s*[\/|]\s*|\s{2,}|\n+/).filter(function (w) { return w.trim(); }).map(function (w) {
        return w.trim().split(/\s+/).map(function (c) { if (DECODE[c]) return DECODE[c]; bad++; return "#"; }).join("");
      }).join(" ");
    return { text: text, bad: bad };
  }

  // Timeline in "units" (1 dot). Returns [{on, off, char}] in units + total length.
  function timeline(morse) {
    var t = 0, out = [], ci = 0;
    morse.trim().split(" ").forEach(function (tok, i, all) {
      if (tok === "/") { t += 4; return; } // 3 already added after the last letter, + 4 = 7
      Array.from(tok).forEach(function (s, k) {
        var len = s === "-" ? 3 : 1;
        out.push({ on: t, off: t + len, char: ci });
        t += len + (k < tok.length - 1 ? 1 : 0);
      });
      ci++;
      if (i < all.length - 1) t += 3;
    });
    return { beeps: out, total: t };
  }

  // Tap decoding: presses [[start, end], …] in ms; unit = one dot in ms.
  function decodeTaps(presses, unit) {
    var out = "", sym = "";
    presses.forEach(function (p, i) {
      sym += p[1] - p[0] < 2 * unit ? "." : "-";
      var next = presses[i + 1];
      var gap = next ? next[0] - p[1] : Infinity;
      if (gap >= 2.5 * unit) { out += DECODE[sym] || "#"; sym = ""; }
      if (next && gap >= 5 * unit) out += " ";
    });
    return out;
  }

  // ---------- settings ----------
  var saved = S3.store("morse.settings") || {};
  var set = { wpm: saved.wpm || 18, tone: saved.tone || 600, vol: saved.vol != null ? saved.vol : 0.5, sound: saved.sound !== false, flash: !!saved.flash };
  var FLASH_MAX_WPM = 6;
  function unitMs() { return 1200 / set.wpm; }
  function persist() { S3.store("morse.settings", set); }
  [["wpm", function (v) { return v + " WPM"; }], ["tone", function (v) { return v + " Hz"; }], ["vol", function (v) { return Math.round(v * 100) + "%"; }]].forEach(function (p) {
    var el = $("#" + p[0]), lbl = $("#" + p[0] + "V");
    el.value = set[p[0]]; lbl.textContent = p[1](+el.value);
    el.addEventListener("input", function () { set[p[0]] = +el.value; lbl.textContent = p[1](+el.value); persist(); if (p[0] === "wpm") $("#tapHint").textContent = tapHint(); });
  });
  ["sound", "flash"].forEach(function (k) {
    var el = $("#" + k); el.checked = set[k];
    el.addEventListener("change", function () { set[k] = el.checked; persist(); $("#lamp").hidden = $("#flashNote").hidden = !set.flash; });
  });
  $("#lamp").hidden = $("#flashNote").hidden = !set.flash;

  // ---------- translator ----------
  var textEl = $("#text"), morseEl = $("#morse"), info = $("#info");
  function fromText() {
    var r = encode(textEl.value);
    morseEl.value = r.morse;
    info.textContent = r.skipped ? r.skipped + " character" + (r.skipped === 1 ? " has" : "s have") + " no Morse code and were skipped." : "";
  }
  function fromMorse() {
    var r = decode(morseEl.value);
    textEl.value = r.text;
    info.textContent = r.bad ? r.bad + " code" + (r.bad === 1 ? " wasn't" : "s weren't") + " recognised (shown as #)." : "";
  }
  textEl.addEventListener("input", fromText);
  morseEl.addEventListener("input", fromMorse);
  $("#copyText").addEventListener("click", function () { if (textEl.value) { S3.copy(textEl.value); S3.done(); } });
  $("#copyMorse").addEventListener("click", function () { if (morseEl.value) { S3.copy(morseEl.value); S3.done(); } });
  $("#clear").addEventListener("click", function () { stop(); textEl.value = ""; morseEl.value = ""; info.textContent = ""; textEl.focus(); });

  // ---------- audio + flash ----------
  var ac = null, playing = null, lamp = $("#lamp"), now = $("#now");
  function audio() {
    if (!ac) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ac = new AC(); }
    if (ac.state === "suspended") ac.resume();
    return ac;
  }
  function play(morse, label) {
    stop();
    if (!morse.trim()) { S3.toast("Nothing to play yet", "error"); return; }
    if (!set.sound && !set.flash) { S3.toast("Turn on Sound or Flash first", "error"); return; }
    // Flash is capped at 6 WPM (≤ 2.5 flashes a second), under the WCAG limit of 3, for people sensitive to flashing light.
    var tl = timeline(morse), u = 1.2 / (set.flash ? Math.min(set.wpm, FLASH_MAX_WPM) : set.wpm), ctx = audio(), t0 = (ctx ? ctx.currentTime : performance.now() / 1000) + 0.08;
    var nodes = [];
    if (set.sound && ctx) {
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = set.tone; osc.type = "sine"; gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      tl.beeps.forEach(function (b) {
        var on = t0 + b.on * u, off = t0 + b.off * u;
        gain.gain.setValueAtTime(0, on);
        gain.gain.linearRampToValueAtTime(set.vol, on + 0.005); // 5 ms ramps avoid clicks
        gain.gain.setValueAtTime(set.vol, off - 0.005);
        gain.gain.linearRampToValueAtTime(0, off);
      });
      osc.start(t0); osc.stop(t0 + tl.total * u + 0.05);
      nodes.push(osc);
    }
    var letters = (label || "").split("");
    playing = { nodes: nodes, raf: 0 };
    $("#play").disabled = true; $("#stop").disabled = false;
    (function frame() {
      var t = (ctx ? ctx.currentTime : performance.now() / 1000) - t0, unitNow = t / u;
      var beep = tl.beeps.filter(function (b) { return unitNow >= b.on && unitNow < b.off; })[0];
      lamp.classList.toggle("on", !!beep && set.flash);
      var last = tl.beeps.filter(function (b) { return b.on <= unitNow; }).pop();
      now.textContent = last ? (letters[last.char] || "") : "";
      if (unitNow > tl.total + 0.5) { stop(); S3.done(); return; }
      playing.raf = requestAnimationFrame(frame);
    })();
  }
  function stop() {
    if (!playing) return;
    cancelAnimationFrame(playing.raf);
    playing.nodes.forEach(function (n) { try { n.stop(); } catch (e) { /* already stopped */ } });
    playing = null; lamp.classList.remove("on"); now.textContent = "";
    $("#play").disabled = false; $("#stop").disabled = true;
  }
  function lettersOf(morse) { return morse.trim().split(" ").filter(function (t) { return t !== "/"; }).map(function (c) { return DECODE[c] || "#"; }).join(""); }
  $("#play").addEventListener("click", function () { play(morseEl.value, lettersOf(morseEl.value)); });
  $("#stop").addEventListener("click", stop);

  // ---------- tap key ----------
  var pad = $("#pad"), tapOut = $("#tapOut"), tapSym = $("#tapSym"), presses = [], downAt = 0, tone = null, timer = 0;
  function tapHint() { return "At " + set.wpm + " WPM: a dot is under " + Math.round(2 * unitMs()) + " ms, pause " + Math.round(2.5 * unitMs()) + " ms between letters and " + Math.round(5 * unitMs()) + " ms between words."; }
  $("#tapHint").textContent = tapHint();
  function renderTaps() {
    var u = unitMs(), k = lastLetterStart(), last = presses[presses.length - 1];
    var idle = !last || performance.now() - last[1] >= 2.5 * u;
    var finished = idle ? presses : presses.slice(0, k), pending = idle ? [] : presses.slice(k);
    var out = decodeTaps(finished, u);
    if (pending.length && k > 0 && presses[k][0] - presses[k - 1][1] >= 5 * u) out += " ";
    tapOut.textContent = out;
    tapSym.textContent = pending.map(function (p) { return p[1] - p[0] < 2 * u ? "·" : "−"; }).join("") || " ";
  }
  function lastLetterStart() {
    for (var i = presses.length - 1; i > 0; i--) if (presses[i][0] - presses[i - 1][1] >= 2.5 * unitMs()) return i;
    return 0;
  }
  function down(e) {
    if (downAt) return;
    if (e) e.preventDefault();
    downAt = performance.now(); pad.classList.add("on");
    var ctx = set.sound && audio();
    if (ctx) {
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.value = set.tone; g.gain.value = 0; osc.connect(g).connect(ctx.destination);
      g.gain.linearRampToValueAtTime(set.vol, ctx.currentTime + 0.005); osc.start();
      tone = { osc: osc, g: g, ctx: ctx };
    }
  }
  function up(e) {
    if (!downAt) return;
    if (e) e.preventDefault();
    presses.push([downAt, performance.now()]); downAt = 0; pad.classList.remove("on");
    if (tone) { var t = tone.ctx.currentTime; tone.g.gain.cancelScheduledValues(t); tone.g.gain.setValueAtTime(tone.g.gain.value, t); tone.g.gain.linearRampToValueAtTime(0, t + 0.005); tone.osc.stop(t + 0.02); tone = null; }
    renderTaps();
    clearTimeout(timer);
    timer = setTimeout(function () { renderTaps(); timer = setTimeout(renderTaps, 2.6 * unitMs()); }, 2.6 * unitMs());
  }
  pad.addEventListener("pointerdown", function (e) { pad.setPointerCapture(e.pointerId); down(e); });
  pad.addEventListener("pointerup", up);
  pad.addEventListener("pointercancel", up);
  pad.addEventListener("keydown", function (e) { if ((e.key === " " || e.key === "Enter") && !e.repeat) down(e); else if (e.key === " " || e.key === "Enter") e.preventDefault(); });
  pad.addEventListener("keyup", function (e) { if (e.key === " " || e.key === "Enter") up(e); });
  $("#tapClear").addEventListener("click", function () { presses = []; renderTaps(); pad.focus(); });
  $("#tapUse").addEventListener("click", function () {
    var t = tapOut.textContent.trim(); if (!t) return;
    textEl.value = t; fromText(); S3.done(); textEl.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  renderTaps();

  // ---------- chart ----------
  var chart = $("#chart");
  Object.keys(CODE).forEach(function (k) {
    chart.appendChild(S3.h("button", { "class": "mc-key", type: "button", "data-k": k, title: "Play " + k }, [S3.h("b", { text: k }), S3.h("span", { text: CODE[k].replace(/\./g, "·").replace(/-/g, "−") })]));
  });
  chart.addEventListener("click", function (e) { var b = e.target.closest("[data-k]"); if (b) play(CODE[b.dataset.k], b.dataset.k); });

  var SAMPLE = "SOS Hello World";
  window.S3_DEMO = function () { textEl.value = SAMPLE; fromText(); };

  window.S3_SELFTEST = function () {
    var t = [
      [encode("SOS").morse, "... --- ..."],
      [encode("Hello World").morse, ".... . .-.. .-.. --- / .-- --- .-. .-.. -.."],
      [encode("é!").morse, ". -.-.--"],
      [encode("A مرحبا B").skipped, 5],
      [decode(".... ..  /  - .... . .-. .").text, "HI THERE"],
      [decode("•••  −−−  •••").text, "S O S"],
      [decode("...|---").text, "S O"],
      [decode("........").bad, 1],
      [decode(encode("Morse 2026, ok?").morse).text, "MORSE 2026, OK?"],
      [timeline(".").total, 1],
      [timeline(".-").total, 5],                 // dot 1 + gap 1 + dash 3
      [timeline(". .").total, 5],                // 1 + letter gap 3 + 1
      [timeline(". / .").total, 9],              // 1 + word gap 7 + 1
      [decodeTaps([[0, 100], [200, 500]], 100), "A"],
      [decodeTaps([[0, 100], [400, 500], [1100, 1400]], 100), "EE T"],
      [decodeTaps([[0, 100], [200, 300], [400, 500], [800, 1100], [1200, 1500], [1600, 1900], [2200, 2300], [2400, 2500], [2600, 2700]], 100), "SOS"]
    ];
    return Object.keys(CODE).length === 54 && t.every(function (p) { return p[0] === p[1]; });
  };
})();
