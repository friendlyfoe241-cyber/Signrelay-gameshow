// Loaded as a classic script because the app itself is a module: a module refuses to run over file://
// or when its bundle is missing, and that failure is silent — a styled but dead page. This file runs in
// every case that matters (classic scripts are not blocked the same way), so it can say what happened
// instead of leaving a booth staring at an empty wheel.
(function () {
  'use strict';
  var CHECK_MS = 2500;
  function fail(reason, fix) {
    var banner = document.createElement('div');
    banner.setAttribute('role', 'alert');
    banner.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;z-index:60;display:grid;gap:6px;' +
      'padding:14px 18px;border:1px solid #b3543f;border-radius:14px;background:#2a130d;color:#ffe9d9;' +
      'font:15px/1.45 system-ui, sans-serif;max-width:640px';
    banner.innerHTML = '<strong style="font-size:16px">GameShow did not start.</strong>' +
      '<span>' + reason + '</span><span style="opacity:.85">' + fix + '</span>';
    document.body.appendChild(banner);
  }
  function check() {
    if (window.__gameBooted) return;
    if (location.protocol === 'file:') {
      fail('This kiosk was opened straight from the folder, which browsers do not allow to run its code.',
        'Open it from the deploy URL, or run <b>npm start</b> in the project and use the address it prints.');
      return;
    }
    fetch('./main.mjs', { method: 'HEAD' }).then(function (response) {
      if (!response.ok) {
        fail('The app bundle is missing from this deployment (main.mjs answered ' + response.status + ').',
          'Run <b>npm run build</b> and deploy again, then hard-refresh this page.');
        return;
      }
      fail('The app bundle loaded but did not start. A cached offline copy may be stuck.',
        'Hard-refresh (Cmd/Ctrl+Shift+R). If it persists, clear this site&rsquo;s storage and reload.');
    }).catch(function () {
      fail('The app bundle could not be fetched. This page is offline or the server is not serving the kiosk build.',
        'Reconnect or redeploy, then hard-refresh this page.');
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(check, CHECK_MS); });
  } else {
    setTimeout(check, CHECK_MS);
  }
})();
