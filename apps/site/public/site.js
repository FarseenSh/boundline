// Live numbers for the landing page: the Observatory's public JSON and the partner API's drills registry, both read
// through this site's own Worker (/obs/*, /live/*), because a browser cannot read either from this origin directly.
// Nothing here is a constant.
(function () {
  var OBS = "/obs";
  var $ = function (id) { return document.getElementById(id); };

  function fmtDuration(seconds) {
    if (seconds <= 0) return "now";
    var d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }
  function fmtAge(seconds) {
    if (seconds < 60) return seconds + " s";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min";
    if (seconds < 172800) return (seconds / 3600).toFixed(1) + " h";
    return (seconds / 86400).toFixed(1) + " d";
  }
  function fmtEt(unix) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(unix * 1000)) + " ET";
    } catch (e) { return new Date(unix * 1000).toUTCString(); }
  }
  function money(x) { return typeof x === "number" ? "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"; }

  function sessions() {
    return fetch(OBS + "/v1/sessions").then(function (r) { return r.json(); }).then(function (s) {
      var now = Math.floor(Date.now() / 1000);
      var live = !!s.isFeedLive;
      $("dot").className = "dot " + (live ? "live" : "closed");
      $("session").textContent = "Wall Street " + (live ? "open (" + s.state + ")" : "closed (" + s.state + ")") + " · feeds " + (live ? "live" : "held");
      if (s.nextFeedTransition) {
        var t = s.nextFeedTransition;
        $("next").textContent = (t.kind === "close" ? "Feeds freeze " : "Feeds reopen ") + fmtEt(t.at) + " (in " + fmtDuration(t.at - now) + ")";
      }
      if (s.lastFeedUpdateAt) $("feeds").textContent = "last feed print " + fmtAge(now - s.lastFeedUpdateAt) + " ago";
    }).catch(function () { $("session").textContent = "Observatory unreachable"; });
  }

  function tokens() {
    return fetch(OBS + "/v1/tokens").then(function (r) { return r.json(); }).then(function (d) {
      var rows = (d.tokens || []).filter(function (t) { return t.feedAnswer && t.feedAnswer !== "0"; });
      var frozen = rows.filter(function (t) { return t.feedFrozen; }).length;
      $("frozenCount").textContent = frozen + " / " + rows.length;
      $("frozenCount").className = "big " + (frozen === 0 ? "live" : "coral");
      $("frozenNote").textContent = frozen === 0 ? "of " + rows.length + " priced feeds are held right now; the session is open." : "of " + rows.length + " priced feeds are holding a stale answer right now.";
      var gaps = rows.map(function (t) { return typeof t.divergenceBps === "number" ? Math.abs(t.divergenceBps) : 0; });
      var worst = gaps.length ? Math.max.apply(null, gaps) : 0;
      $("gapMax").textContent = worst.toFixed(0) + " bps";
      $("gapMax").className = "big " + (worst >= 100 ? "coral" : "");
      var tb = $("tokens").querySelector("tbody");
      tb.innerHTML = "";
      rows.forEach(function (t) {
        var tr = document.createElement("tr");
        var state = t.feedFrozen ? '<span class="tag bad">held</span>' : t.feedLive ? '<span class="tag live">live</span>' : '<span class="tag warn">' + (t.session || "") + "</span>";
        tr.innerHTML = "<td>" + t.symbol + "</td><td class=num>" + money(t.feedPrice) + "</td><td class=num>" + fmtAge(t.feedAgeSeconds || 0) + "</td><td class=num>" + money(t.dexPrice) + "</td><td class=num>" + (typeof t.divergenceBps === "number" ? t.divergenceBps.toFixed(0) + " bps" : "—") + "</td><td>" + state + "</td>";
        tb.appendChild(tr);
      });
      if (rows.length === 0) tb.innerHTML = '<tr><td colspan="6" class="mute">No priced feeds in the snapshot.</td></tr>';
    }).catch(function () {
      $("tokens").querySelector("tbody").innerHTML = '<tr><td colspan="6" class="mute">Observatory unreachable.</td></tr>';
      $("frozenCount").textContent = "—"; $("gapMax").textContent = "—";
    });
  }

  function drills() {
    return fetch("/live/drills").then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(function (d) {
      var rows = Array.isArray(d) ? d : (d.drills || []);
      var withRuns = rows.filter(function (x) { return (x.runs || []).length > 0; });
      var runs = rows.reduce(function (n, x) { return n + (x.runs || []).length; }, 0);
      $("drillCount").textContent = withRuns.length + " / " + rows.length;
      $("drillNote").textContent = "drills have recorded runs (" + runs + " runs in all), each with its transaction hashes; the rest are defined and waiting for their run.";
      var list = $("drillList");
      list.innerHTML = "";
      rows.forEach(function (x) {
        var li = document.createElement("li");
        var n = (x.runs || []).length;
        li.innerHTML = '<span class="tag ' + (n > 0 ? "live" : "") + '">' + (n > 0 ? n + (n === 1 ? " run" : " runs") : "defined") + "</span> " + x.title;
        list.appendChild(li);
      });
    }).catch(function () { $("drillCount").textContent = "—"; $("drillNote").textContent = "The partner API did not answer."; });
  }

  sessions(); tokens(); drills();
  setInterval(sessions, 60000); setInterval(tokens, 60000);
})();
