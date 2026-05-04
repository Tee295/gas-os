/* Dark mode toggle — apply before body renders to avoid flash */
(function () {
  var KEY = 'gas_theme';
  var saved = localStorage.getItem(KEY);
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);

  window.applyTheme = function (t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(KEY, t);
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.title = t === 'dark' ? 'สลับโหมดสว่าง' : 'สลับโหมดมืด';
    });
  };

  window.toggleTheme = function () {
    var current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  };

  window.getTheme = function () {
    return document.documentElement.getAttribute('data-theme');
  };
})();
