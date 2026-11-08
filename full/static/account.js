"use strict";
/* Your account (Cody 11/7: "change own password"): change your own password, or sign out. Used by the app (mission.js: the
   signed-in chip, the admin's name button) and by an AHJ reviewer's page (dasreview.js). Forgotten passwords: Cody makes a new one
   from the people list (New password). The server ends every other session of yours when it changes (remote.change_password),
   and gives this one a new cookie, so this device stays signed in. */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const ROLE = {view: "view only", full: "full", admin: "admin", ahj: "reviewer"};

  window.openAccount = function (me) {
    let d = document.getElementById("acctDlg");
    if (!d) {
      d = document.createElement("dialog");
      d.id = "acctDlg";
      d.setAttribute("aria-labelledby", "acctTitle");
      d.style.cssText = "max-width:420px;width:calc(100% - 32px);border:1px solid var(--line);border-radius:18px;padding:18px 20px;color:var(--ink);background:var(--panel,var(--glass,#1e1a16))";
      document.body.append(d);
      d.addEventListener("click", e => { if (e.target === d) d.close(); });  // a press outside the box closes it
    }
    d.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><strong id="acctTitle">Your account</strong><span style="flex:1"></span>
        <button type="button" id="acctX" aria-label="Close">✕</button></div>
      <p>Signed in as <b>${esc(me.user)}</b> (${esc(ROLE[me.role] || me.role)}).</p>
      <form id="pwForm"><h4 style="margin:12px 0 4px">Change your password</h4>
        <input type="text" name="username" autocomplete="username" value="${esc(me.user)}" hidden>
        <label class="hint" for="pwCur" style="display:block;margin-top:6px">Current password</label>
        <input id="pwCur" type="password" autocomplete="current-password" required style="width:100%;box-sizing:border-box">
        <label class="hint" for="pwNew" style="display:block;margin-top:6px">New password: at least 10 characters</label>
        <input id="pwNew" type="password" autocomplete="new-password" minlength="10" required style="width:100%;box-sizing:border-box">
        <label class="hint" for="pwNew2" style="display:block;margin-top:6px">New password again</label>
        <input id="pwNew2" type="password" autocomplete="new-password" minlength="10" required style="width:100%;box-sizing:border-box">
        <p style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 0">
          <button type="submit" class="primary" id="pwSave">Change password</button><span id="pwMsg" class="hint" role="status"></span></p>
        <p class="hint">Your other devices are signed out when it changes; this one stays signed in.</p></form>
      ${me.role === "ahj" ? "" : `<label style="display:flex;flex-direction:row;gap:10px;align-items:flex-start;margin:14px 0 0;border-top:1px solid var(--line);padding-top:12px;cursor:pointer">
        <input type="checkbox" id="acctAuto" style="margin-top:4px"><span><b>Update by itself</b><br><span class="hint">When DAStastic is updated on the server, this
        browser reloads the next time you leave the tab. Off: a chip says so and you reload when you choose.</span></span></label>`}
      <p style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:14px 0 0;border-top:1px solid var(--line);padding-top:12px">
        <a class="hbtn btn" id="pwOut" href="/remote/logout" style="text-decoration:none">Sign out</a>
        <span class="hint">Forgot your password? Ask Cody for a new one.</span></p>`;
    d.querySelector("#acctX").onclick = () => d.close();
    const $ = s => d.querySelector(s);
    // item 7: the same choice (rfr.autoUpdate) mission.js watchBuild reads; not on a reviewer's page, which has no build watch
    const au = $("#acctAuto");
    if (au) {
      try { au.checked = localStorage.getItem("rfr.autoUpdate") !== "0"; } catch (e) { au.checked = true; }
      au.onchange = () => { try { localStorage.setItem("rfr.autoUpdate", au.checked ? "1" : "0"); } catch (e) { /* private window: the default stays */ } };
    }
    $("#pwForm").onsubmit = async e => {
      e.preventDefault();
      const msg = $("#pwMsg");
      if ($("#pwNew").value !== $("#pwNew2").value) { msg.textContent = "The two new passwords don't match."; return; }
      $("#pwSave").disabled = true; msg.textContent = "Changing…";
      try {
        const r = await fetch("/remote/password", {method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({current: $("#pwCur").value, new: $("#pwNew").value})});
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { msg.textContent = j.error || `Not changed (${r.status}).`; return; }
        $("#pwForm").reset(); msg.textContent = "Changed. Use the new password next time you sign in.";
      } catch (err) { msg.textContent = "Not changed: the server didn't answer. Try again."; }
      finally { $("#pwSave").disabled = false; }
    };
    d.showModal(); $("#pwCur").focus();
  };
})();
