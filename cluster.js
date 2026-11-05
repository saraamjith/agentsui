// AgentsCluster -- pure HTML-string renderers for the cluster panels.
// The listings are the real kgpus / tgpus / squeue output; this only turns their
// colour escapes into spans and pulls a one-line summary for the toolbar.
(function () {
  "use strict";

  var esc = function (s) { return AgentsCards.esc(s); };

  // The dock terminals' palette, so kgpus looks the way it does in one of them.
  var BASE = ["#20182C", "#FF91C8", "#9BC7FF", "#D2ADFF", "#86B5F9", "#E49BEF", "#AAB7FF", "#EEE5FA",
              "#9A8DAB", "#FFB8DF", "#C0DDFF", "#E7CCFF", "#BAD8FF", "#F5C5FF", "#D0D7FF", "#FFFFFF"];
  var LEVELS = [0, 95, 135, 175, 215, 255];

  function color256(n) {
    if (n < 16) return BASE[n];
    if (n >= 232) { var g = 8 + 10 * (n - 232); return "rgb(" + g + "," + g + "," + g + ")"; }
    n -= 16;
    return "rgb(" + LEVELS[Math.floor(n / 36)] + "," + LEVELS[Math.floor(n / 6) % 6] + "," + LEVELS[n % 6] + ")";
  }

  function strip(text) {
    return String(text || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  }

  // SGR escapes to spans: bold, dim, 16/256/truecolour foregrounds. Anything
  // else (cursor movement, clears) is dropped.
  function ansi(text) {
    var out = "", bold = false, dim = false, fg = null;
    var parts = String(text || "").replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, "").split(/\x1b\[([0-9;]*)m/);
    for (var i = 0; i < parts.length; i++) {
      if (i % 2) {
        var codes = parts[i] === "" ? [0] : parts[i].split(";").map(Number);
        for (var j = 0; j < codes.length; j++) {
          var c = codes[j];
          if (c === 0) { bold = dim = false; fg = null; }
          else if (c === 1) bold = true;
          else if (c === 2) dim = true;
          else if (c === 22) bold = dim = false;
          else if (c === 39) fg = null;
          else if (c >= 30 && c <= 37) fg = BASE[c - 30];
          else if (c >= 90 && c <= 97) fg = BASE[c - 82];
          else if (c === 38 && codes[j + 1] === 5) { fg = color256(codes[j + 2] || 0); j += 2; }
          else if (c === 38 && codes[j + 1] === 2) { fg = "rgb(" + codes.slice(j + 2, j + 5).join(",") + ")"; j += 4; }
        }
        continue;
      }
      if (!parts[i]) continue;
      var cls = (bold ? "a-b " : "") + (dim ? "a-d" : "");
      if (!cls && !fg) { out += esc(parts[i]); continue; }
      out += '<span' + (cls.trim() ? ' class="' + cls.trim() + '"' : "") +
        (fg ? ' style="color:' + fg + '"' : "") + ">" + esc(parts[i]) + "</span>";
    }
    return out;
  }

  // kgpus and tgpus end their node list with "free  b300 0   h100 6 ..."; keep the non-zero ones.
  function freeGpus(text) {
    var line = strip(text).split("\n").find(function (l) { return /^\s*free\s/.test(l); });
    if (!line) return [];
    var pairs = [], re = /(\S+)\s+(\d+)/g, m, rest = line.replace(/^\s*free\s+/, "");
    while ((m = re.exec(rest))) if (+m[2]) pairs.push([m[1], +m[2]]);
    return pairs;
  }

  // squeue's ST column: R running, PD pending, everything else counted as other.
  // With prefixes, only jobs that may run on a partition starting with one of
  // them count; a pending job's PARTITION is a comma list of its candidates.
  function jobCounts(text, prefixes) {
    var lines = strip(text).split("\n").filter(function (l) { return l.trim(); });
    var head = lines.length ? lines[0].trim().split(/\s+/) : [];
    var col = head.indexOf("ST"), pcol = head.indexOf("PARTITION");
    var counts = { running: 0, pending: 0 };
    if (col < 0) return counts;
    lines.slice(1).forEach(function (l) {
      var cells = l.trim().split(/\s+/), st = cells[col];
      if (prefixes && prefixes.length && !String(cells[pcol] || "").split(",").some(function (p) {
        return prefixes.some(function (x) { return p.indexOf(x) === 0; });
      })) return;
      if (st === "R") counts.running++;
      else if (st === "PD") counts.pending++;
    });
    return counts;
  }

  function button(k) {
    var gpus = freeGpus(k.output.gpus), jobs = jobCounts(k.output.jobs, k.count);
    var name = esc(k.name);
    if (!k.fetched && k.fetching) return name + " <i>loading…</i>";
    var free = gpus.length
      ? gpus.map(function (p) { return "<b>" + esc(p[0]) + " " + p[1] + "</b>"; }).join(" ") + " free"
      : "<i>no gpus free</i>";
    return name + " <i>·</i> " + free + " <i>·</i> " + jobs.running + " running" +
      (jobs.pending ? " <i>· " + jobs.pending + " queued</i>" : "");
  }

  function clock(epoch) {
    var d = new Date(epoch * 1000);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function head(k, now) {
    var when;
    if (!k.connected) when = "not connected - ssh into " + esc(k.host) + " in any terminal and this fills in";
    else if (k.fetching) when = "refreshing…";
    else if (k.fetched) {
      var next = Math.max(0, Math.round((k.fetched + k.every - now) / 60));
      when = "updated " + clock(k.fetched) + " (" + AgentsCards.ago(now - k.fetched) + " ago) · next in " + next + "m";
    } else when = "not fetched yet";
    return "<b>" + esc(k.host) + "</b><span>" + when + "</span>" +
      '<button class="tbtn" type="button" data-refresh="1"' + (k.connected && !k.fetching ? "" : " disabled") + ">refresh</button>";
  }

  function section(k, key, label) {
    var err = k.errors[key];
    return "<h3>" + esc(label) + " <i>·</i> <span>$ " + esc(k.commands[key]) + "</span>" +
      (err ? ' <span class="bad">failed: ' + esc(err) + (k.output[key] ? " (showing the last good one)" : "") + "</span>" : "") +
      "</h3><pre>" + ansi((k.output[key] || "").replace(/\s+$/, "")) + "</pre>";
  }

  // Your jobs first: a few lines that would otherwise sit under the long GPU list.
  function body(k) {
    return section(k, "jobs", "your jobs") + section(k, "gpus", "gpus");
  }

  window.AgentsCluster = { ansi: ansi, freeGpus: freeGpus, jobCounts: jobCounts, button: button, head: head, body: body };
})();
