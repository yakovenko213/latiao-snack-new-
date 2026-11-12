/* shipbar.js — плашка «Найближча відправка» над шапкою сайту.
   Показується на всіх сторінках, крім cart.html та checkout.html.
   Логіка (час Києва):
     до 10:30          → відправка сьогодні до 12:00
     після 10:30       → відправка сьогодні до 17:00
     після 17:02       → найближча відправка завтра до 12:00
*/
(function () {
  'use strict';
  var path = location.pathname.split('/').pop().toLowerCase();
  if (path === 'cart.html' || path === 'checkout.html') return;

  function kyivNow() {
    // Київський час незалежно від налаштувань пристрою (UTC+2/UTC+3)
    var now = new Date();
    var utc = now.getTime() + now.getTimezoneOffset() * 60000;
    var k = new Date(utc + 2 * 3600000); // базово UTC+2
    // літній час: остання неділя березня — остання неділя жовтня
    var y = k.getFullYear();
    function lastSunday(month) { var d = new Date(y, month + 1, 0); return d.getDate() - d.getDay(); }
    var dstStart = new Date(y, 2, lastSunday(2), 3, 0, 0);
    var dstEnd = new Date(y, 9, lastSunday(9), 4, 0, 0);
    if (k >= dstStart && k < dstEnd) k = new Date(utc + 3 * 3600000);
    return k;
  }

  function text() {
    var d = kyivNow();
    var h = d.getHours(), m = d.getMinutes();
    var t = h * 60 + m;
    if (t < 10 * 60 + 30) return 'Відправка сьогодні до 12:00';
    if (t < 17 * 60 + 2) return 'Відправка сьогодні до 17:00';
    return 'Найближча відправка — завтра до 12:00';
  }

  function build() {
    var bar = document.createElement('div');
    bar.className = 'shipbar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span class="shipbar__txt">' + text() + '</span>';
    var css = document.createElement('style');
    css.textContent =
      '.shipbar{position:relative;z-index:60;background:var(--color-ink,#1B1B1B);color:var(--color-cream,#FFF4E6);'
      + 'text-align:center;padding:8px 16px;font-family:var(--font-head,Montserrat,sans-serif);font-weight:700;'
      + 'font-size:.8rem;letter-spacing:.01em;margin-inline:calc(-1*max(16px,env(safe-area-inset-left,0px)));'
      + 'padding-inline:max(16px,env(safe-area-inset-left,0px))}'
      + '.shipbar__txt{display:inline-block}'
      + 'body::before{height:0!important}';
    document.head.appendChild(css);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
