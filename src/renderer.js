const el = (id) => document.getElementById(id);

const statusBox = el('status');
const c = el('hr-chart');
const data = { labels: [], values: [] };

// Chart.js line
const chart = new Chart(c.getContext('2d'), {
    type: 'line',
    data: {
        labels: data.labels,
        datasets: [{ data: data.values }]
    },
    options: {
        animation: false,
        responsive: false,
        scales: {
            x: { display: false },
            y: { beginAtZero: false }
        },
        plugins: { legend: { display: false } }
    }
});

function pushPoint(hr) {
    const now = new Date();
    data.labels.push(now.toLocaleTimeString());
    data.values.push(hr);
    if (data.labels.length > 120) { data.labels.shift(); data.values.shift(); }
    chart.update('none');
}

function setText(id, val) { el(id).innerText = (val ?? '--'); }

function renderStatus(s) {
    statusBox.innerHTML = `
    <div>Realtime: <strong>${s.realtimeEnabled ? 'ON' : 'OFF'}</strong></div>
    <div>Discord RPC: <strong>${s.discordRpcEnabled ? 'ON' : 'OFF'}</strong></div>
    <div>WS Connected: <strong>${s.connected ? 'Yes' : 'No'}</strong></div>
  `;
}

window.api.getStatus().then(renderStatus);

window.api.onHeartRate((payload) => {
    if (payload?.type === 'status') { renderStatus(payload); return; }
    const { hr, stats } = payload;
    if (typeof hr === 'number') {
        setText('v-current', `${hr}`);
        pushPoint(hr);
    }
    if (stats) {
        setText('v-avg', stats.avg);
        setText('v-min', stats.min);
        setText('v-max', stats.max);
    }
});