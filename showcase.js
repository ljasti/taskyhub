(function () {
	const SLIDES = [
		{ id: 'canvas-white', src: 'assets/showcase/canvas-white.png', alt: 'TaskyHub workflow canvas', theme: 'white' },
		{ id: 'dashboard-white', src: 'assets/showcase/dashboard-white.png', alt: 'TaskyHub analytics dashboard', theme: 'white' },
		{ id: 'admin-white', src: 'assets/showcase/admin-white.png', alt: 'TaskyHub admin settings', theme: 'white' },
	];

	const INTERVAL_MS = 5000;

	function currentTheme() {
		return document.documentElement.classList.contains('theme-blue') ? 'blue' : 'white';
	}

	function slidesForTheme(theme) {
		const themed = SLIDES.filter((s) => s.theme === theme);
		return themed.length ? themed : SLIDES;
	}

	function initShowcase(root) {
		let index = 0;
		let slides = slidesForTheme(currentTheme());
		const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const track = root.querySelector('.marketing-showcase-track');
		const dotsHost = root.querySelector('.marketing-showcase-dots');
		if (!track || !dotsHost) return;

		let images = [];
		let dots = [];
		let timer = null;

		function renderSlides() {
			track.innerHTML = '';
			dotsHost.innerHTML = '';
			images = [];
			dots = [];
			slides.forEach((slide, i) => {
				const img = document.createElement('img');
				img.className = 'marketing-showcase-slide';
				img.src = slide.src;
				img.alt = slide.alt;
				img.loading = i === 0 ? 'eager' : 'lazy';
				img.decoding = 'async';
				track.appendChild(img);
				images.push(img);

				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'marketing-showcase-dot';
				btn.setAttribute('role', 'tab');
				btn.setAttribute('aria-label', slide.alt);
				btn.addEventListener('click', () => setIndex(i));
				dotsHost.appendChild(btn);
				dots.push(btn);
			});
			index = 0;
			setIndex(0);
		}

		function setIndex(next) {
			index = next % slides.length;
			images.forEach((img, i) => {
				img.classList.toggle('marketing-showcase-slide--active', i === index);
			});
			dots.forEach((dot, i) => {
				const active = i === index;
				dot.classList.toggle('marketing-showcase-dot--active', active);
				dot.setAttribute('aria-selected', active ? 'true' : 'false');
			});
		}

		function restartTimer() {
			if (timer) window.clearInterval(timer);
			if (reduceMotion || slides.length <= 1) return;
			timer = window.setInterval(() => setIndex(index + 1), INTERVAL_MS);
		}

		renderSlides();
		restartTimer();

		window.addEventListener('taskyhub-theme-change', () => {
			slides = slidesForTheme(currentTheme());
			renderSlides();
			restartTimer();
		});
	}

	document.querySelectorAll('[data-marketing-showcase]').forEach(initShowcase);
})();
