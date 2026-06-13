(function () {
	const DATA_7 = {
		runsPerDay: [98, 112, 105, 142, 121, 118, 151],
		runsTotal: 847,
		successRate: 91.3,
		failed: 74,
		latency: 2.4,
		sparklines: {
			runs: [72, 88, 94, 101, 108, 118, 124],
			success: [86.2, 87.4, 88.1, 89.0, 90.2, 90.8, 91.3],
			latency: [3.1, 2.9, 2.8, 2.7, 2.6, 2.5, 2.4],
			failed: [18, 16, 14, 13, 12, 11, 10],
		},
	};

	const DATA_30 = {
		runsPerDay: [92, 104, 98, 118, 110, 125, 132],
		runsTotal: 3240,
		successRate: 90.1,
		failed: 321,
		latency: 2.6,
		sparklines: {
			runs: [64, 78, 86, 92, 98, 105, 112],
			success: [85.0, 86.2, 87.1, 88.0, 88.8, 89.5, 90.1],
			latency: [3.4, 3.2, 3.0, 2.9, 2.8, 2.7, 2.6],
			failed: [22, 20, 19, 18, 17, 16, 15],
		},
	};

	function cssVar(name, fallback) {
		const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		return v || fallback;
	}

	function drawSparkline(svg, values, tone) {
		if (!svg || !values.length) return;
		const w = 128;
		const h = 28;
		const pad = 2;
		const max = Math.max(...values);
		const min = Math.min(...values);
		const range = max - min || 1;
		const pts = values.map((v, i) => {
			const x = pad + (i / (values.length - 1)) * (w - pad * 2);
			const y = h - pad - ((v - min) / range) * (h - pad * 2);
			return `${x},${y}`;
		});
		const stroke =
			tone === 'success'
				? cssVar('--color-success-text', '#047857')
				: tone === 'danger'
					? cssVar('--color-danger-text', '#b91c1c')
					: cssVar('--color-primary-500', '#1596b8');
		svg.innerHTML = `<polyline fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pts.join(' ')}" />`;
	}

	function drawBarChart(svg, values) {
		if (!svg) return;
		const max = Math.max(...values);
		const barW = 56;
		const gap = 24;
		const baseY = 160;
		const fill = cssVar('--color-primary-500', '#1596b8');
		const isBlue = document.documentElement.classList.contains('theme-blue');
		const barFill = isBlue ? cssVar('--color-primary-300', '#4db8d9') : fill;
		let bars = '';
		values.forEach((v, i) => {
			const h = Math.max(8, (v / max) * 130);
			const x = 20 + i * (barW + gap);
			const y = baseY - h;
			bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="8" fill="${barFill}" opacity="${0.72 + i * 0.04}" />`;
		});
		svg.innerHTML = `<line x1="12" y1="${baseY}" x2="548" y2="${baseY}" stroke="${cssVar('--color-border-subtle', 'rgba(15,23,42,0.12)')}" />${bars}`;
	}

	function setDonut(pct) {
		const ring = document.querySelector('[data-donut-value]');
		if (!ring) return;
		const r = 46;
		const c = 2 * Math.PI * r;
		const offset = c * (1 - pct / 100);
		ring.setAttribute('stroke-dasharray', `${c}`);
		ring.setAttribute('stroke-dashoffset', `${offset}`);
	}

	function applyData(data) {
		const runsEl = document.querySelector('[data-kpi="runs"]');
		const successEl = document.querySelector('[data-kpi="success"]');
		const latencyEl = document.querySelector('[data-kpi="latency"]');
		const failedEl = document.querySelector('[data-kpi="failed"]');
		const sub = document.querySelector('.hubAnalyticsPreviewSub');
		const pct = document.querySelector('.hubAnalyticsDonutPct');

		if (runsEl) runsEl.textContent = data.runsTotal.toLocaleString();
		if (successEl) successEl.textContent = `${data.successRate}%`;
		if (latencyEl) latencyEl.textContent = `${data.latency}s`;
		if (failedEl) failedEl.textContent = String(data.failed);
		if (sub) sub.textContent = `Last ${data === DATA_30 ? 30 : 7} days · Refreshed 2 min ago · ${data.runsTotal.toLocaleString()} runs`;
		if (pct) pct.textContent = `${data.successRate}%`;

		document.querySelectorAll('[data-sparkline]').forEach((svg) => {
			const key = svg.getAttribute('data-sparkline');
			const tone = svg.classList.contains('analyticsSparkline--success')
				? 'success'
				: svg.classList.contains('analyticsSparkline--danger')
					? 'danger'
					: 'primary';
			drawSparkline(svg, data.sparklines[key] || [], tone);
		});

		drawBarChart(document.querySelector('[data-bar-chart]'), data.runsPerDay);
		setDonut(data.successRate);
	}

	function initTabs(root) {
		root.querySelectorAll('.hubAnalyticsTab').forEach((btn) => {
			btn.addEventListener('click', () => {
				root.querySelectorAll('.hubAnalyticsTab').forEach((b) => {
					b.classList.remove('is-active');
					b.setAttribute('aria-selected', 'false');
				});
				btn.classList.add('is-active');
				btn.setAttribute('aria-selected', 'true');
				const period = btn.getAttribute('data-period');
				applyData(period === '30' ? DATA_30 : DATA_7);
			});
		});
	}

	function init() {
		const root = document.querySelector('[data-analytics-preview]');
		if (!root) return;
		initTabs(root);
		applyData(DATA_7);
		window.addEventListener('taskyhub-theme-change', () => {
			const active = root.querySelector('.hubAnalyticsTab.is-active');
			const period = active?.getAttribute('data-period');
			applyData(period === '30' ? DATA_30 : DATA_7);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
