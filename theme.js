(function initTaskyHubMarketingTheme() {
	function applyWhiteTheme() {
		const root = document.documentElement;
		root.classList.remove('theme-blue', 'theme-dark', 'theme-light', 'theme-dark');
		root.classList.add('theme-white', 'theme-light');
		root.removeAttribute('data-theme-variant-blue');
		document.body.classList.add('th-app-body');
	}

	applyWhiteTheme();
})();
