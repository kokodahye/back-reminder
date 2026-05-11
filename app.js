(() => {
  'use strict';

  // --- DOM ---
  const $ = (id) => document.getElementById(id);
  const phaseLabel = $('phaseLabel');
  const timerDisplay = $('timerDisplay');
  const cycleCount = $('cycleCount');
  const progressRing = $('progressRing');
  const actionBtn = $('actionBtn');
  const sittingTime = $('sittingTime');
  const sittingBar = $('sittingBar');
  const sittingLimit = $('sittingLimit');
  const sittingInfo = $('sittingInfo');
  const settingsOverlay = $('settingsOverlay');
  const alertModal = $('alertModal');
  const alertTitle = $('alertTitle');
  const alertMessage = $('alertMessage');
  const alertBtn = $('alertBtn');
  const alertIcon = $('alertIcon');
  const activityMinEl = $('activityMin');
  const restMinEl = $('restMin');
  const sittingLimitRange = $('sittingLimitRange');
  const sittingLimitLabel = $('sittingLimitLabel');
  const notifPermBtn = $('notifPermBtn');
  const notifStatus = $('notifStatus');

  const RING_CIRCUMFERENCE = 2 * Math.PI * 90; // ~565.48

  // --- Firebase Sync State ---
  let firebaseApp = null;
  let syncRef = null;
  let syncListener = null;
  let syncCode = null;
  let isSyncing = false;
  let healthSyncTimer = null;

  // --- State ---
  let settings = loadSettings();
  let state = {
    phase: 'idle',        // idle | activity | rest | waiting | over-limit
    remainingSeconds: 0,
    totalSittingSeconds: 0,
    cycles: 0,
    intervalId: null,
    sittingIntervalId: null,
    dayKey: todayKey()
  };

  // --- Settings ---
  function defaultSettings() {
    return {
      activityMin: 40,
      restMin: 5,
      sittingLimitHours: 5,
      scheduleStart: '09:00',
      scheduleEnd: '00:00'
    };
  }

  function loadSettings() {
    try {
      const saved = localStorage.getItem('backTimerSettings');
      if (saved) return { ...defaultSettings(), ...JSON.parse(saved) };
    } catch (e) { /* ignore */ }
    return defaultSettings();
  }

  function saveSettings() {
    try {
      localStorage.setItem('backTimerSettings', JSON.stringify(settings));
    } catch (e) { /* storage full */ }
  }

  function saveSittingState() {
    try {
      localStorage.setItem('backTimerSitting', JSON.stringify({
        totalSittingSeconds: state.totalSittingSeconds,
        cycles: state.cycles,
        dayKey: state.dayKey
      }));
      // 오늘 기록도 일별 기록에 저장
      saveDailyRecord(state.dayKey, state.totalSittingSeconds);
    } catch (e) { /* storage full */ }

    // Firebase 동기화 (30초마다)
    if (syncRef && !isSyncing) {
      const lastPush = parseInt(localStorage.getItem('backTimerLastPush') || '0');
      if (Date.now() - lastPush > 30000) {
        localStorage.setItem('backTimerLastPush', String(Date.now()));
        pushToFirebase();
      }
    }
  }

  function loadSittingState() {
    try {
      const saved = localStorage.getItem('backTimerSitting');
      if (saved) {
        const data = JSON.parse(saved);
        if (data.dayKey === todayKey()) {
          state.totalSittingSeconds = data.totalSittingSeconds || 0;
          state.cycles = data.cycles || 0;
          state.dayKey = data.dayKey;
        } else {
          // 날짜가 바뀌었으면 이전 날 기록 확정 저장
          if (data.dayKey && data.totalSittingSeconds > 0) {
            saveDailyRecord(data.dayKey, data.totalSittingSeconds);
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // --- Daily History ---
  function loadHistory() {
    try {
      const saved = localStorage.getItem('backTimerHistory');
      return saved ? JSON.parse(saved) : {};
    } catch (e) { return {}; }
  }

  function saveDailyRecord(dayKey, seconds) {
    try {
      const history = loadHistory();
      history[dayKey] = seconds;
      // 최근 30일만 유지
      const keys = Object.keys(history).sort();
      while (keys.length > 30) {
        delete history[keys.shift()];
      }
      localStorage.setItem('backTimerHistory', JSON.stringify(history));
    } catch (e) { /* storage full */ }
  }

  function renderHistory() {
    const historyList = $('historyList');
    const history = loadHistory();
    // 오늘 기록도 포함
    const today = todayKey();
    history[today] = state.totalSittingSeconds;

    const days = Object.keys(history).sort().reverse();
    if (days.length === 0) {
      historyList.innerHTML = '<div class="history-empty">아직 기록이 없습니다</div>';
      return;
    }

    const limitSec = settings.sittingLimitHours * 3600;
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];

    historyList.innerHTML = days.map((key) => {
      const sec = history[key];
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const pct = Math.min((sec / limitSec) * 100, 100);
      const isOver = sec >= limitSec;
      const isToday = key === today;

      // 날짜 파싱
      const parts = key.split('-');
      const dateObj = new Date(+parts[0], +parts[1] - 1, +parts[2]);
      const wd = weekdays[dateObj.getDay()];
      const label = isToday ? '오늘' : `${+parts[1]}/${+parts[2]}`;

      return `<div class="history-item">
        <span class="history-date">${label}<span class="weekday">${wd}</span></span>
        <div class="history-bar-wrap"><div class="history-bar-fill ${isOver ? 'over' : ''}" style="width:${pct}%"></div></div>
        <span class="history-time">${h}시간 ${m}분</span>
      </div>`;
    }).join('');
  }

  // --- Timer Logic ---
  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatSitting(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    return `${h}시간 ${m}분`;
  }

  function updateTimerUI() {
    timerDisplay.textContent = formatTime(state.remainingSeconds);

    let totalSeconds;
    if (state.phase === 'activity') {
      totalSeconds = settings.activityMin * 60;
    } else if (state.phase === 'rest') {
      totalSeconds = settings.restMin * 60;
    } else {
      totalSeconds = settings.activityMin * 60;
    }

    const progress = state.phase === 'idle' || state.phase === 'waiting'
      ? 0
      : 1 - (state.remainingSeconds / totalSeconds);
    const offset = RING_CIRCUMFERENCE * (1 - progress);
    progressRing.style.strokeDasharray = RING_CIRCUMFERENCE;
    progressRing.style.strokeDashoffset = offset;
  }

  function updateSittingUI() {
    sittingTime.textContent = formatSitting(state.totalSittingSeconds);
    const limitSeconds = settings.sittingLimitHours * 3600;
    const pct = Math.min((state.totalSittingSeconds / limitSeconds) * 100, 100);
    sittingBar.style.width = pct + '%';
    sittingLimit.textContent = settings.sittingLimitHours + '시간';

    const isOver = state.totalSittingSeconds >= limitSeconds;
    sittingBar.classList.toggle('warning', isOver);
    sittingInfo.classList.toggle('over-limit', isOver);
  }

  function setPhaseClass(phase) {
    document.body.className = '';
    if (phase === 'activity') document.body.classList.add('phase-activity');
    else if (phase === 'rest') document.body.classList.add('phase-rest');
    else if (phase === 'over-limit') document.body.classList.add('phase-warning');
  }

  function startCountdown(totalSeconds, onTick, onEnd) {
    clearInterval(state.intervalId);
    state.countdownStart = Date.now();
    state.countdownTotal = totalSeconds;
    state.countdownOnEnd = onEnd;
    state.remainingSeconds = totalSeconds;
    updateTimerUI();

    state.intervalId = setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.countdownStart) / 1000);
      state.remainingSeconds = Math.max(0, state.countdownTotal - elapsed);
      onTick();
      if (state.remainingSeconds <= 0) {
        clearInterval(state.intervalId);
        state.intervalId = null;
        onEnd();
      }
    }, 250);
  }

  // 백그라운드 복귀 시 타이머 즉시 갱신
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.intervalId && state.countdownStart) {
      const elapsed = Math.floor((Date.now() - state.countdownStart) / 1000);
      state.remainingSeconds = Math.max(0, state.countdownTotal - elapsed);
      updateTimerUI();
      if (state.remainingSeconds <= 0) {
        clearInterval(state.intervalId);
        state.intervalId = null;
        if (state.countdownOnEnd) {
          state.countdownOnEnd();
          state.countdownOnEnd = null;
        }
      }
    }
  });

  function startActivity() {
    state.phase = 'activity';
    phaseLabel.textContent = '활동';
    actionBtn.textContent = '정지';
    actionBtn.classList.remove('danger');
    setPhaseClass('activity');

    startCountdown(settings.activityMin * 60, updateTimerUI, onActivityEnd);
    startSittingTracker();
  }

  function startRest() {
    state.phase = 'rest';
    phaseLabel.textContent = '휴식';
    actionBtn.textContent = '건너뛰기';
    actionBtn.classList.remove('danger');
    setPhaseClass('rest');

    stopSittingTracker();
    startCountdown(settings.restMin * 60, updateTimerUI, onRestEnd);
  }

  function onActivityEnd() {
    state.cycles++;
    cycleCount.textContent = `${state.cycles}회 완료`;
    showAlert(
      '허리 운동 시간!',
      `${settings.activityMin}분이 지났습니다.\n잠시 일어나서 허리 스트레칭을 해주세요.`,
      '휴식 시작',
      () => startRest()
    );
    sendNotification('허리 운동 시간!', `${settings.activityMin}분이 지났습니다. 허리 스트레칭을 해주세요.`);
    playSound();
  }

  function onRestEnd() {
    state.phase = 'waiting';
    phaseLabel.textContent = '대기';
    timerDisplay.textContent = formatTime(0);
    actionBtn.textContent = '다시 시작';
    actionBtn.classList.remove('danger');
    setPhaseClass('');
    updateTimerUI();

    showAlert(
      '휴식 완료!',
      `${settings.restMin}분 휴식이 끝났습니다.\n준비되면 다시 시작 버튼을 눌러주세요.`,
      '확인',
      () => {}
    );
    sendNotification('휴식 완료!', '준비되면 다시 시작 버튼을 눌러주세요.');
    playSound();
  }

  function stopTimer() {
    clearInterval(state.intervalId);
    stopSittingTracker();
    state.phase = 'idle';
    state.remainingSeconds = settings.activityMin * 60;
    phaseLabel.textContent = '준비';
    actionBtn.textContent = '시작';
    actionBtn.classList.remove('danger');
    setPhaseClass('');
    updateTimerUI();
  }

  // --- Sitting Tracker ---
  function startSittingTracker() {
    clearInterval(state.sittingIntervalId);
    state.sittingIntervalId = setInterval(() => {
      // Reset if day changed
      const key = todayKey();
      if (key !== state.dayKey) {
        // 이전 날 기록 확정 저장
        if (state.totalSittingSeconds > 0) {
          saveDailyRecord(state.dayKey, state.totalSittingSeconds);
        }
        state.totalSittingSeconds = 0;
        state.cycles = 0;
        cycleCount.textContent = '';
        state.dayKey = key;
      }

      state.totalSittingSeconds++;
      updateSittingUI();
      if (state.totalSittingSeconds % 10 === 0) saveSittingState();

      // Check sitting limit
      const limitSeconds = settings.sittingLimitHours * 3600;
      if (state.totalSittingSeconds >= limitSeconds && state.phase === 'activity') {
        clearInterval(state.intervalId);
        clearInterval(state.sittingIntervalId);
        state.phase = 'over-limit';
        setPhaseClass('over-limit');
        phaseLabel.textContent = '제한 초과';
        actionBtn.textContent = '초기화';
        actionBtn.classList.add('danger');
        showAlert(
          '앉은 시간 초과!',
          `오늘 총 ${formatSitting(state.totalSittingSeconds)} 앉았습니다.\n${settings.sittingLimitHours}시간 제한을 초과했습니다.\n오늘은 충분히 앉았으니 쉬어주세요.`,
          '확인',
          () => {}
        );
        sendNotification('앉은 시간 초과!', `${settings.sittingLimitHours}시간 제한을 초과했습니다.`);
        playSound();
      }
    }, 1000);
  }

  function stopSittingTracker() {
    clearInterval(state.sittingIntervalId);
  }

  // --- Notifications ---
  function sendNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title, {
            body: body,
            icon: 'icon.svg',
            badge: 'icon.svg',
            vibrate: [200, 100, 200],
            tag: 'back-timer',
            renotify: true
          });
        });
      } else {
        new Notification(title, { body: body, icon: 'icon.svg' });
      }
    }
  }

  // iOS AudioContext 미리 활성화 (첫 터치 시)
  let sharedAudioCtx = null;
  let alarmStopFn = null;

  function unlockAudio() {
    if (!sharedAudioCtx) {
      sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // 무음 재생으로 iOS 잠금 해제
      const buf = sharedAudioCtx.createBuffer(1, 1, 22050);
      const src = sharedAudioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(sharedAudioCtx.destination);
      src.start(0);
    }
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume();
    }
  }

  // 첫 터치/클릭 시 오디오 활성화
  document.addEventListener('touchstart', unlockAudio, { once: true });
  document.addEventListener('click', unlockAudio, { once: true });

  function stopAlarm() {
    if (alarmStopFn) {
      alarmStopFn();
      alarmStopFn = null;
    }
  }

  function playSound() {
    stopAlarm(); // 이전 알람 정지
    try {
      unlockAudio();
      const ctx = sharedAudioCtx;
      if (!ctx) return;

      const masterGain = ctx.createGain();
      masterGain.gain.value = 1.0; // 최대 볼륨
      masterGain.connect(ctx.destination);

      // 우렁찬 알람 멜로디 (3회 반복, 총 ~10초)
      // 삼각파 + 사인파 중첩으로 풍성한 소리
      const pattern = [
        { freq: 880,   dur: 0.15 },  // A5
        { freq: 0,     dur: 0.05 },  // 쉼
        { freq: 880,   dur: 0.15 },  // A5
        { freq: 0,     dur: 0.05 },  // 쉼
        { freq: 1108,  dur: 0.25 },  // C#6
        { freq: 0,     dur: 0.1  },  // 쉼
        { freq: 880,   dur: 0.15 },  // A5
        { freq: 0,     dur: 0.05 },  // 쉼
        { freq: 1108,  dur: 0.15 },  // C#6
        { freq: 0,     dur: 0.05 },  // 쉼
        { freq: 1318,  dur: 0.4  },  // E6 (길게)
        { freq: 0,     dur: 0.6  },  // 쉼 (다음 반복 전 대기)
      ];

      const allOsc = [];
      const repeats = 4; // 4회 반복

      for (let r = 0; r < repeats; r++) {
        let t = 0;
        // 반복마다 시작 시간 계산
        const repeatOffset = r * 2.5;

        pattern.forEach(({ freq, dur }) => {
          if (freq > 0) {
            // 메인 음 (삼각파 - 풍성한 소리)
            const osc1 = ctx.createOscillator();
            const g1 = ctx.createGain();
            osc1.type = 'triangle';
            osc1.frequency.value = freq;
            g1.gain.setValueAtTime(0, ctx.currentTime + repeatOffset + t);
            g1.gain.linearRampToValueAtTime(0.7, ctx.currentTime + repeatOffset + t + 0.02);
            g1.gain.setValueAtTime(0.7, ctx.currentTime + repeatOffset + t + dur * 0.5);
            g1.gain.linearRampToValueAtTime(0.001, ctx.currentTime + repeatOffset + t + dur);
            osc1.connect(g1);
            g1.connect(masterGain);
            osc1.start(ctx.currentTime + repeatOffset + t);
            osc1.stop(ctx.currentTime + repeatOffset + t + dur + 0.05);
            allOsc.push(osc1);

            // 보조 음 (사인파 - 1옥타브 아래로 두께감)
            const osc2 = ctx.createOscillator();
            const g2 = ctx.createGain();
            osc2.type = 'sine';
            osc2.frequency.value = freq / 2;
            g2.gain.setValueAtTime(0, ctx.currentTime + repeatOffset + t);
            g2.gain.linearRampToValueAtTime(0.4, ctx.currentTime + repeatOffset + t + 0.02);
            g2.gain.setValueAtTime(0.4, ctx.currentTime + repeatOffset + t + dur * 0.5);
            g2.gain.linearRampToValueAtTime(0.001, ctx.currentTime + repeatOffset + t + dur);
            osc2.connect(g2);
            g2.connect(masterGain);
            osc2.start(ctx.currentTime + repeatOffset + t);
            osc2.stop(ctx.currentTime + repeatOffset + t + dur + 0.05);
            allOsc.push(osc2);

            // 고음 배음 추가 (밝은 느낌)
            const osc3 = ctx.createOscillator();
            const g3 = ctx.createGain();
            osc3.type = 'sine';
            osc3.frequency.value = freq * 2;
            g3.gain.setValueAtTime(0, ctx.currentTime + repeatOffset + t);
            g3.gain.linearRampToValueAtTime(0.15, ctx.currentTime + repeatOffset + t + 0.02);
            g3.gain.setValueAtTime(0.15, ctx.currentTime + repeatOffset + t + dur * 0.3);
            g3.gain.linearRampToValueAtTime(0.001, ctx.currentTime + repeatOffset + t + dur * 0.8);
            osc3.connect(g3);
            g3.connect(masterGain);
            osc3.start(ctx.currentTime + repeatOffset + t);
            osc3.stop(ctx.currentTime + repeatOffset + t + dur + 0.05);
            allOsc.push(osc3);
          }
          t += dur;
        });
      }

      // 알람 정지 함수 등록
      alarmStopFn = () => {
        allOsc.forEach((o) => { try { o.stop(); } catch (e) {} });
        masterGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.1);
      };

      // 10초 후 자동 정지
      setTimeout(stopAlarm, 10000);

    } catch (e) { /* ignore */ }
  }

  // --- Alert Modal ---
  function showAlert(title, message, btnText, onClose) {
    alertTitle.textContent = title;
    alertMessage.textContent = message;
    alertBtn.textContent = btnText;
    if (title.includes('초과')) {
      alertIcon.textContent = '🚨';
    } else if (title.includes('휴식')) {
      alertIcon.textContent = '✅';
    } else {
      alertIcon.textContent = '⏰';
    }
    alertModal.classList.remove('hidden');

    // 팝업 펄스 애니메이션 (눈에 띄게)
    const box = alertModal.querySelector('.alert-box');
    box.classList.add('alert-pulse');

    alertBtn.onclick = () => {
      stopAlarm(); // 알람 소리 정지
      box.classList.remove('alert-pulse');
      alertModal.classList.add('hidden');
      onClose();
    };
  }

  // --- Settings Panel ---
  function openSettings() {
    // Sync UI with current settings
    activityMinEl.textContent = settings.activityMin;
    restMinEl.textContent = settings.restMin;
    sittingLimitRange.value = settings.sittingLimitHours;
    sittingLimitLabel.textContent = settings.sittingLimitHours + '시간';
    updateNotifStatus();
    settingsOverlay.classList.remove('hidden');
  }

  function closeSettings() {
    settingsOverlay.classList.add('hidden');
    // Apply settings if idle
    if (state.phase === 'idle') {
      state.remainingSeconds = settings.activityMin * 60;
      updateTimerUI();
    }
    updateSittingUI();
  }

  function updateNotifStatus() {
    if (!('Notification' in window)) {
      notifStatus.textContent = '이 브라우저는 알림을 지원하지 않습니다.';
      notifPermBtn.style.display = 'none';
    } else if (Notification.permission === 'granted') {
      notifStatus.textContent = '알림이 허용되었습니다.';
      notifPermBtn.style.display = 'none';
    } else if (Notification.permission === 'denied') {
      notifStatus.textContent = '알림이 차단되었습니다. 브라우저 설정에서 허용해주세요.';
      notifPermBtn.style.display = 'none';
    } else {
      notifStatus.textContent = '';
      notifPermBtn.style.display = '';
    }
  }

  // --- Event Listeners ---
  actionBtn.addEventListener('click', () => {
    switch (state.phase) {
      case 'idle':
      case 'waiting':
        startActivity();
        break;
      case 'activity':
      case 'rest':
        stopTimer();
        break;
      case 'over-limit':
        state.totalSittingSeconds = 0;
        state.phase = 'idle';
        stopTimer();
        updateSittingUI();
        break;
    }
  });

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });

  // Stepper buttons
  document.querySelectorAll('.stepper-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      const delta = parseInt(btn.dataset.delta);
      if (target === 'activityMin') {
        settings.activityMin = Math.max(5, Math.min(120, settings.activityMin + delta));
        activityMinEl.textContent = settings.activityMin;
      } else if (target === 'restMin') {
        settings.restMin = Math.max(1, Math.min(30, settings.restMin + delta));
        restMinEl.textContent = settings.restMin;
      }
      saveSettings();
    });
  });

  // 활동/휴식 시간 클릭 시 직접 입력
  function makeEditable(el, settingKey, min, max) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      if (el.querySelector('input')) return;
      const current = settings[settingKey];
      const input = document.createElement('input');
      input.type = 'number';
      input.value = current;
      input.min = min;
      input.max = max;
      input.style.cssText = 'width:48px;font-size:20px;font-weight:700;text-align:center;border:1.5px solid var(--primary);border-radius:8px;background:var(--bg);color:var(--text);padding:2px 4px;outline:none;';
      el.textContent = '';
      el.appendChild(input);
      input.focus();
      input.select();
      const commit = () => {
        const val = Math.max(min, Math.min(max, parseInt(input.value) || current));
        settings[settingKey] = val;
        el.textContent = val;
        saveSettings();
        if (state.phase === 'idle') updateTimerUI();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
    });
  }
  makeEditable(activityMinEl, 'activityMin', 5, 120);
  makeEditable(restMinEl, 'restMin', 1, 30);

  sittingLimitRange.addEventListener('input', () => {
    settings.sittingLimitHours = parseFloat(sittingLimitRange.value);
    sittingLimitLabel.textContent = settings.sittingLimitHours + '시간';
    saveSettings();
  });

  notifPermBtn.addEventListener('click', () => {
    if ('Notification' in window) {
      Notification.requestPermission().then((perm) => {
        updateNotifStatus();
      });
    }
  });

  // History panel
  $('historyBtn').addEventListener('click', () => {
    renderHistory();
    $('historyOverlay').classList.remove('hidden');
  });
  $('historyClose').addEventListener('click', () => {
    $('historyOverlay').classList.add('hidden');
  });
  $('historyOverlay').addEventListener('click', (e) => {
    if (e.target === $('historyOverlay')) $('historyOverlay').classList.add('hidden');
  });

  $('resetDayBtn').addEventListener('click', () => {
    state.totalSittingSeconds = 0;
    saveSittingState();
    updateSittingUI();
    if (state.phase === 'over-limit') {
      stopTimer();
    }
  });

  // --- Firebase Sync ---
  const firebaseConfig = {
    apiKey: "AIzaSyDWI6cA7X0ARycj11Gc5svhD55ANw_0qe8",
    authDomain: "back-keeper-b0392.firebaseapp.com",
    databaseURL: "https://back-keeper-b0392-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "back-keeper-b0392",
    storageBucket: "back-keeper-b0392.firebasestorage.app",
    messagingSenderId: "967355521579",
    appId: "1:967355521579:web:d56ec54aaff2b6f6bb686e"
  };

  function initFirebase() {
    try {
      if (typeof firebase !== 'undefined' && !firebaseApp) {
        firebaseApp = firebase.initializeApp(firebaseConfig);
      }
    } catch (e) { /* already initialized */ }
  }

  function generateSyncCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  function connectSync(code) {
    initFirebase();
    if (!firebaseApp || typeof firebase === 'undefined') {
      // Firebase가 아직 안 로드됨 → 코드는 저장해두고 나중에 재시도
      syncCode = code.toUpperCase();
      localStorage.setItem('backTimerSyncCode', syncCode);
      updateSyncUI();
      // 1초 후 재시도 (최대 10회)
      let retries = 0;
      const retryInterval = setInterval(() => {
        retries++;
        initFirebase();
        if (firebaseApp && typeof firebase !== 'undefined') {
          clearInterval(retryInterval);
          connectSync(syncCode);
        } else if (retries >= 10) {
          clearInterval(retryInterval);
        }
      }, 1000);
      return false;
    }

    // 이전 리스너만 해제 (localStorage는 건드리지 않음)
    if (syncRef && syncListener) {
      syncRef.off('value', syncListener);
    }
    syncRef = null;
    syncListener = null;

    syncCode = code.toUpperCase();
    const db = firebase.database();
    syncRef = db.ref('sync/' + syncCode);

    // 현재 데이터 업로드
    pushToFirebase();

    // 실시간 리스너 등록
    syncListener = syncRef.on('value', (snapshot) => {
      const data = snapshot.val();
      if (!data || isSyncing) return;

      // 원격 데이터가 더 최신이면 적용
      const remoteTimestamp = data.lastUpdated || 0;
      const localTimestamp = parseInt(localStorage.getItem('backTimerSyncTS') || '0');

      if (remoteTimestamp > localTimestamp) {
        isSyncing = true;

        // 앉은 시간 동기화
        if (data.sitting) {
          const today = todayKey();
          if (data.sitting.dayKey === today) {
            // 더 큰 값 사용 (두 기기 중 더 많이 앉은 쪽)
            if (data.sitting.totalSittingSeconds > state.totalSittingSeconds) {
              state.totalSittingSeconds = data.sitting.totalSittingSeconds;
            }
            state.cycles = Math.max(state.cycles, data.sitting.cycles || 0);
          }
        }

        // 히스토리 동기화 (병합)
        if (data.history) {
          try {
            const localHistory = loadHistory();
            const merged = { ...localHistory, ...data.history };
            // 각 날짜별로 더 큰 값 사용
            Object.keys(localHistory).forEach((key) => {
              if (data.history[key]) {
                merged[key] = Math.max(localHistory[key], data.history[key]);
              }
            });
            // 최근 30일만 유지
            const keys = Object.keys(merged).sort();
            while (keys.length > 30) {
              delete merged[keys.shift()];
            }
            localStorage.setItem('backTimerHistory', JSON.stringify(merged));
          } catch (e) { /* ignore */ }
        }

        // 설정 동기화
        if (data.settings) {
          settings = { ...settings, ...data.settings };
          saveSettings();
        }

        // 건강 기록 동기화 (병합)
        if (data.healthRecords) {
          try {
            const localRecords = loadHealthRecords();
            const remoteRecords = data.healthRecords;
            const merged = { ...localRecords };
            Object.keys(remoteRecords).forEach((key) => {
              const remote = remoteRecords[key];
              const local = localRecords[key];
              if (!local) {
                merged[key] = remote;
              } else {
                if ((remote.savedAt || 0) > (local.savedAt || 0)) {
                  merged[key] = remote;
                }
              }
            });
            localStorage.setItem(HEALTH_STORAGE_KEY, JSON.stringify(merged));
          } catch (e) { /* ignore */ }
        }

        localStorage.setItem('backTimerSyncTS', String(remoteTimestamp));
        saveSittingState();
        updateSittingUI();
        updateTimerUI();
        updateSyncUI();

        // 건강 기록 UI 새로고침
        try {
          if (!document.getElementById('healthView').classList.contains('hidden')) {
            loadTodayCheckUI();
          }
        } catch (e) { /* 초기 로드 시 무시 */ }

        isSyncing = false;
      }
    });

    // 동기화 코드 저장
    localStorage.setItem('backTimerSyncCode', syncCode);
    updateSyncUI();
    return true;
  }

  function pushToFirebase() {
    if (!syncRef || isSyncing) return;
    isSyncing = true;

    // 원격 데이터를 먼저 읽고 병합 후 업로드 (덮어쓰기 방지)
    syncRef.once('value').then((snapshot) => {
      const remote = snapshot.val() || {};
      const now = Date.now();

      // 건강 기록 병합
      const localHealth = loadHealthRecords();
      const remoteHealth = remote.healthRecords || {};
      const mergedHealth = { ...remoteHealth };
      Object.keys(localHealth).forEach((key) => {
        const loc = localHealth[key];
        const rem = remoteHealth[key];
        if (!rem || (loc.savedAt || 0) >= (rem.savedAt || 0)) {
          mergedHealth[key] = loc;
        }
      });

      // 히스토리 병합
      const localHistory = loadHistory();
      const remoteHistory = remote.history || {};
      const mergedHistory = { ...remoteHistory, ...localHistory };
      Object.keys(remoteHistory).forEach((key) => {
        if (localHistory[key]) {
          mergedHistory[key] = Math.max(localHistory[key], remoteHistory[key]);
        }
      });
      const histKeys = Object.keys(mergedHistory).sort();
      while (histKeys.length > 30) delete mergedHistory[histKeys.shift()];

      const data = {
        sitting: {
          totalSittingSeconds: state.totalSittingSeconds,
          cycles: state.cycles,
          dayKey: state.dayKey
        },
        history: mergedHistory,
        settings: settings,
        healthRecords: mergedHealth,
        lastUpdated: now
      };

      return syncRef.set(data).then(() => {
        localStorage.setItem('backTimerSyncTS', String(now));
        // 병합된 데이터를 로컬에도 반영
        localStorage.setItem(HEALTH_STORAGE_KEY, JSON.stringify(mergedHealth));
        localStorage.setItem('backTimerHistory', JSON.stringify(mergedHistory));
        isSyncing = false;
      });
    }).catch(() => {
      isSyncing = false;
    });
  }

  function disconnectSync(clearStorage) {
    if (syncRef && syncListener) {
      syncRef.off('value', syncListener);
    }
    syncRef = null;
    syncListener = null;
    syncCode = null;
    if (clearStorage) {
      localStorage.removeItem('backTimerSyncCode');
      localStorage.removeItem('backTimerSyncTS');
    }
    updateSyncUI();
  }

  function updateSyncUI() {
    const notConnected = $('syncNotConnected');
    const connected = $('syncConnected');
    const codeDisplay = $('syncCodeDisplay');
    const statusEl = $('syncStatus');

    const displayCode = syncCode || localStorage.getItem('backTimerSyncCode');

    if (displayCode) {
      notConnected.style.display = 'none';
      connected.style.display = 'block';
      codeDisplay.textContent = displayCode;
      if (syncRef) {
        statusEl.textContent = '✓ 동기화 연결됨';
        statusEl.style.color = 'var(--primary)';
      } else {
        statusEl.textContent = '⏳ 연결 중...';
        statusEl.style.color = 'var(--text-sub)';
      }
    } else {
      notConnected.style.display = 'block';
      connected.style.display = 'none';
    }
  }

  // Sync UI 이벤트
  $('syncNewBtn').addEventListener('click', () => {
    const code = generateSyncCode();
    $('syncCodeInput').value = code;
    connectSync(code);
  });

  $('syncJoinBtn').addEventListener('click', () => {
    const code = $('syncCodeInput').value.trim();
    if (code.length < 4) {
      alert('동기화 코드를 입력해주세요.');
      return;
    }
    connectSync(code);
  });

  $('syncDisconnectBtn').addEventListener('click', () => {
    disconnectSync(true);
  });

  // ========================================
  // 허리 기록 (Back Health Tracking)
  // 타이머 데이터와 완전히 분리된 별도 저장소
  // ========================================

  const HEALTH_STORAGE_KEY = 'backHealthRecords';
  const ACTIVITY_TYPES = ['앉은 시간', '걷기', '스트레칭', '맨손체조', 'MST체조', '근력운동', '유산소', '휴식', '기타'];

  const BAR_CATEGORIES = ['앉은 시간', '걸은 시간', '운동한 시간', '휴식한 시간'];
  const BAR_COLORS = ['#D4A843', '#5B9BD5', '#E8913A', '#D46A6A'];

  function mapActivityToCategory(type) {
    if (type === '앉은 시간') return '앉은 시간';
    if (type === '걷기') return '걸은 시간';
    if (type === '휴식') return '휴식한 시간';
    return '운동한 시간';
  }

  function categorizeRecord(record) {
    const cats = { '앉은 시간': 0, '걸은 시간': 0, '운동한 시간': 0, '휴식한 시간': 0 };
    if (!record || !record.activities) return cats;
    record.activities.forEach((a) => {
      cats[mapActivityToCategory(a.type)] += a.minutes || 0;
    });
    return cats;
  }

  // 활동 추가 모달 상태
  let activityModalState = {
    selectedType: null,
    customName: '',
    minutes: 30
  };

  // 그래프 상태
  let graphState = {
    periodType: 'weekly',
    anchorDate: new Date()
  };

  let healthSelectedDate = todayKey();
  let calendarMonth = new Date();

  function loadHealthRecords() {
    try {
      const saved = localStorage.getItem(HEALTH_STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch (e) { return {}; }
  }

  function saveHealthRecords(records) {
    try {
      localStorage.setItem(HEALTH_STORAGE_KEY, JSON.stringify(records));
    } catch (e) { /* storage full */ }
    if (syncRef && !isSyncing) {
      clearTimeout(healthSyncTimer);
      healthSyncTimer = setTimeout(() => pushToFirebase(), 2000);
    }
  }

  function getSelectedRecord() {
    const records = loadHealthRecords();
    return records[healthSelectedDate] || {
      painScore: 7,
      activities: [],
      period: false,
      note: ''
    };
  }

  function painScoreLabel(score) {
    if (score >= 9) return '아주 좋음';
    if (score >= 7) return '괜찮음';
    if (score >= 5) return '보통';
    if (score >= 3) return '아픔';
    return '매우 아픔';
  }

  function painScoreColor(score) {
    if (score >= 7) return 'good';
    if (score >= 4) return 'mid';
    return 'bad';
  }

  // ---- View / Tab Switching ----
  function switchView(view) {
    const timerView = $('timerView');
    const healthView = $('healthView');
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    if (view === 'timer') {
      timerView.classList.remove('hidden');
      healthView.classList.add('hidden');
      $('headerTitle').textContent = '허리 알리미';
    } else {
      timerView.classList.add('hidden');
      healthView.classList.remove('hidden');
      $('headerTitle').textContent = '허리 기록';
      // 진입 시 오늘 데이터 로드
      loadTodayCheckUI();
    }
  }

  function switchSubtab(subtab) {
    document.querySelectorAll('.health-subtab').forEach((b) => {
      b.classList.toggle('active', b.dataset.subtab === subtab);
    });
    $('checkSection').classList.toggle('hidden', subtab !== 'check');
    $('graphSection').classList.toggle('hidden', subtab !== 'graph');
    if (subtab === 'graph') renderGraph();
  }

  // ---- Today Check UI ----
  function loadTodayCheckUI() {
    const rec = getSelectedRecord();
    const range = $('painScoreRange');
    range.value = rec.painScore;
    updatePainDisplay(rec.painScore);
    $('periodCheck').checked = !!rec.period;
    $('checkNote').value = rec.note || '';
    // 비타민 체크 로드
    const vit = rec.vitamins || {};
    document.querySelectorAll('.vitamin-check').forEach((cb) => {
      cb.checked = !!vit[cb.dataset.key];
    });
    renderActivityList(rec.activities || []);

    const parts = healthSelectedDate.split('-');
    const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    $('checkDateLabel').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
  }

  function updatePainDisplay(score) {
    $('painScoreBig').textContent = score;
    $('painScoreLabel').textContent = painScoreLabel(score);
    // 색상도 변경
    let color = 'var(--primary)';
    if (score < 4) color = 'var(--danger)';
    else if (score < 7) color = '#d4a017';
    $('painScoreBig').style.color = color;
  }

  function renderActivityList(activities) {
    const list = $('activityList');
    if (!activities || activities.length === 0) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = activities.map((a, i) => `
      <div class="activity-item">
        <span class="activity-item-type">${escapeHtml(a.type)}</span>
        <span class="activity-item-min">${a.minutes}분</span>
        <button class="activity-item-del" data-index="${i}" aria-label="삭제">✕</button>
      </div>
    `).join('');

    list.querySelectorAll('.activity-item-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        const today = getSelectedRecord();
        today.activities.splice(idx, 1);
        saveSelectedRecord(today);
        renderActivityList(today.activities);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function saveSelectedRecord(rec) {
    const records = loadHealthRecords();
    records[healthSelectedDate] = rec;
    saveHealthRecords(records);
  }

  // ---- Activity Modal ----
  function openActivityModal() {
    activityModalState = { selectedType: null, customName: '' };
    $('actMinInput').value = '30';
    $('customTypeGroup').style.display = 'none';
    $('customTypeInput').value = '';
    document.querySelectorAll('.activity-type-btn').forEach((b) => b.classList.remove('selected'));
    $('activityModal').classList.remove('hidden');
  }

  function closeActivityModal() {
    $('activityModal').classList.add('hidden');
  }

  function commitActivity() {
    const type = activityModalState.selectedType;
    if (!type) {
      flashMsg('saveCheckMsg', '활동 종류를 선택해주세요', 'var(--danger)');
      return;
    }
    let finalType = type;
    if (type === '기타') {
      const custom = $('customTypeInput').value.trim();
      if (!custom) {
        $('customTypeInput').focus();
        return;
      }
      finalType = custom;
    }
    const minutes = parseInt($('actMinInput').value) || 0;
    if (minutes <= 0) return;

    const today = getSelectedRecord();
    today.activities = today.activities || [];
    today.activities.push({ type: finalType, minutes });
    saveSelectedRecord(today);
    renderActivityList(today.activities);
    closeActivityModal();
  }

  function flashMsg(id, text, color) {
    const el = $(id);
    el.textContent = text;
    el.style.color = color || 'var(--primary)';
    setTimeout(() => { el.textContent = ''; }, 2500);
  }

  // ---- Save Today ----
  function saveTodayCheck() {
    const vitamins = {};
    document.querySelectorAll('.vitamin-check').forEach((cb) => {
      vitamins[cb.dataset.key] = cb.checked;
    });
    const rec = {
      painScore: parseInt($('painScoreRange').value),
      activities: getSelectedRecord().activities || [],
      period: $('periodCheck').checked,
      vitamins: vitamins,
      note: $('checkNote').value.trim(),
      savedAt: Date.now()
    };
    saveSelectedRecord(rec);
    flashMsg('saveCheckMsg', '✓ 저장되었습니다');
  }

  // ---- Graph Navigation ----
  function getDateRange() {
    const anchor = graphState.anchorDate;
    const type = graphState.periodType;
    let start, end;

    if (type === 'weekly') {
      const day = anchor.getDay();
      const diff = day === 0 ? 6 : day - 1; // 월요일 시작
      start = new Date(anchor);
      start.setDate(anchor.getDate() - diff);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
    } else if (type === 'monthly') {
      start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    } else {
      start = new Date(anchor.getFullYear(), 0, 1);
      end = new Date(anchor.getFullYear(), 11, 31);
    }
    return { start, end };
  }

  function navigateGraph(direction) {
    const d = graphState.anchorDate;
    const type = graphState.periodType;
    if (type === 'weekly') d.setDate(d.getDate() + direction * 7);
    else if (type === 'monthly') d.setMonth(d.getMonth() + direction);
    else d.setFullYear(d.getFullYear() + direction);
    renderGraph();
  }

  function updateDateRangeLabel() {
    const { start, end } = getDateRange();
    const type = graphState.periodType;
    let text;
    if (type === 'weekly') {
      text = `${start.getMonth()+1}월 ${start.getDate()}일 ~ ${end.getMonth()+1}월 ${end.getDate()}일`;
    } else if (type === 'monthly') {
      text = `${start.getFullYear()}년 ${start.getMonth()+1}월`;
    } else {
      text = `${start.getFullYear()}년`;
    }
    $('dateRangeLabel').textContent = text;
  }

  function collectPoints() {
    const records = loadHealthRecords();
    const { start, end } = getDateRange();
    const type = graphState.periodType;
    const points = [];

    if (type === 'yearly') {
      for (let m = 0; m < 12; m++) {
        const monthStart = new Date(start.getFullYear(), m, 1);
        const monthEnd = new Date(start.getFullYear(), m + 1, 0);
        let sum = 0, count = 0, actSum = 0, actCount = 0;
        const allRecs = [];
        for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
          const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          const rec = records[key];
          if (rec) {
            allRecs.push(rec);
            if (typeof rec.painScore === 'number') { sum += rec.painScore; count++; }
            const total = (rec.activities || []).reduce((s, a) => s + (a.minutes || 0), 0);
            if (total > 0) { actSum += total; actCount++; }
          }
        }
        points.push({
          date: monthStart,
          label: `${m+1}월`,
          painValue: count > 0 ? Math.round(sum / count * 10) / 10 : null,
          actValue: actCount > 0 ? Math.round(actSum / actCount) : null,
          records: allRecs
        });
      }
    } else {
      const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const rec = records[key];
        const painVal = rec && typeof rec.painScore === 'number' ? rec.painScore : null;
        const actTotal = rec ? (rec.activities || []).reduce((s, a) => s + (a.minutes || 0), 0) : 0;
        let label;
        if (type === 'weekly') {
          label = weekdays[d.getDay()];
        } else {
          label = `${d.getDate()}`;
        }
        points.push({
          date: new Date(d),
          key,
          label,
          painValue: painVal,
          actValue: actTotal > 0 ? actTotal : null,
          record: rec || null,
          records: rec ? [rec] : []
        });
      }
    }
    return points;
  }

  // ---- Graph ----
  function renderGraph() {
    const points = collectPoints();
    updateDateRangeLabel();

    // 통증 차트
    const hasData = points.some((p) => p.painValue !== null);
    $('chartEmpty').classList.toggle('hidden', hasData);
    drawPainChart(points);
    const valid = points.filter((p) => p.painValue !== null);
    if (valid.length > 0) {
      const avg = valid.reduce((s, p) => s + p.painValue, 0) / valid.length;
      $('chartAvg').innerHTML = `평균 <strong>${avg.toFixed(1)}</strong> 점`;
    } else {
      $('chartAvg').innerHTML = '';
    }

    // 공통 포인트
    const allPoints = points.map((p) => ({
      ...p,
      value: p.painValue,
      record: p.record || (p.records && p.records.length > 0 ? p.records[0] : null)
    }));

    // 스택 차트 + 합계
    renderActivityBreakdown(allPoints);
    renderRecentRecords(allPoints);
    renderActivityAverage(allPoints);
  }

  function drawPainChart(points) {
    const svg = $('chartSvg');
    const W = 360, H = 200;
    const PAD_L = 8, PAD_R = 8, PAD_T = 28, PAD_B = 28;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;
    const yMax = 10, yMin = 0;

    const xAt = (i) => PAD_L + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const yAt = (v) => PAD_T + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

    const dataPoints = points.map((p, i) => ({
      ...p, i, x: xAt(i),
      y: p.painValue !== null ? yAt(p.painValue) : null
    }));
    const validPoints = dataPoints.filter((p) => p.y !== null);

    // smooth path
    function smoothPath(pts) {
      if (pts.length === 0) return '';
      if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
      let path = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const tension = 0.4;
        const cp1x = p0.x + (p1.x - p0.x) * tension;
        const cp2x = p1.x - (p1.x - p0.x) * tension;
        path += ` C ${cp1x} ${p0.y}, ${cp2x} ${p1.y}, ${p1.x} ${p1.y}`;
      }
      return path;
    }

    let svgContent = '';

    // 기준선 (얇은 점선)
    const baseLine = yAt(0);
    svgContent += `<line x1="${PAD_L}" y1="${baseLine}" x2="${W - PAD_R}" y2="${baseLine}" stroke="#e2e6dc" stroke-width="1"/>`;

    // 라인
    const linePath = smoothPath(validPoints);
    if (linePath) {
      svgContent += `<path d="${linePath}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    }

    // x축 라벨
    const labelStep = points.length > 12 ? Math.ceil(points.length / 10) : 1;
    dataPoints.forEach((p, i) => {
      if (i % labelStep === 0 || i === points.length - 1) {
        svgContent += `<text x="${p.x}" y="${H - 6}" text-anchor="middle" fill="var(--text-sub)" font-size="11" font-weight="500">${p.label}</text>`;
      }
    });

    // 데이터 점 + 값 라벨
    validPoints.forEach((p) => {
      // 점
      svgContent += `<circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--primary)" stroke="#fff" stroke-width="2"/>`;
      // 값 라벨 (모든 포인트에 표시)
      const labelY = p.y - 12;
      svgContent += `<text x="${p.x}" y="${labelY}" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="700">${p.painValue}</text>`;
    });

    svg.innerHTML = svgContent;
  }

  function renderActivityBreakdown(points) {
    const svg = $('stackedChartSvg');
    if (!svg) return;

    // 날짜별 카테고리 집계
    const buckets = points.map((p) => {
      const cats = { '앉은 시간': 0, '걸은 시간': 0, '운동한 시간': 0, '휴식한 시간': 0 };
      const recs = p.records || (p.record ? [p.record] : []);
      recs.forEach((r) => {
        if (!r || !r.activities) return;
        const c = categorizeRecord(r);
        BAR_CATEGORIES.forEach((cat) => { cats[cat] += c[cat]; });
      });
      // 분 → 시간 변환
      BAR_CATEGORIES.forEach((cat) => { cats[cat] = Math.round(cats[cat] * 10 / 60) / 10; });
      return { label: p.label, cats };
    });

    const W = 360, H = 200;
    const PAD_L = 28, PAD_R = 8, PAD_T = 8, PAD_B = 28;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;

    // y축 max (각 날짜의 4카테고리 합산 중 최대)
    const maxTotal = Math.max(...buckets.map((b) => BAR_CATEGORIES.reduce((s, c) => s + b.cats[c], 0)), 1);
    const yMax = Math.ceil(maxTotal / 2) * 2 || 2;
    const yAt = (v) => PAD_T + innerH - (v / yMax) * innerH;

    const n = buckets.length;
    const barW = Math.max(12, Math.min(36, (innerW / n) * 0.65));
    const gap = (innerW - barW * n) / (n + 1);

    let svgContent = '';

    // y축 그리드 + 라벨
    const ySteps = yMax <= 6 ? 1 : yMax <= 12 ? 2 : Math.ceil(yMax / 5);
    for (let t = 0; t <= yMax; t += ySteps) {
      const y = yAt(t);
      svgContent += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#ebeae3" stroke-width="1"/>`;
      svgContent += `<text x="${PAD_L - 6}" y="${y + 4}" text-anchor="end" fill="var(--text-sub)" font-size="10" font-weight="500">${t}</text>`;
    }

    // 스택 바 그리기
    buckets.forEach((b, i) => {
      const bx = PAD_L + gap + i * (barW + gap);
      let baseY = yAt(0);

      BAR_CATEGORIES.forEach((cat, ci) => {
        const val = b.cats[cat];
        if (val <= 0) return;
        const barH = (val / yMax) * innerH;
        const by = baseY - barH;
        const isTop = ci === BAR_CATEGORIES.length - 1 || BAR_CATEGORIES.slice(ci + 1).every((c) => b.cats[c] <= 0);
        const isBottom = ci === 0 || BAR_CATEGORIES.slice(0, ci).every((c) => b.cats[c] <= 0);
        const rx = (isTop || isBottom) ? 3 : 0;
        if (isTop && !isBottom) {
          svgContent += `<rect x="${bx}" y="${by}" width="${barW}" height="${barH}" fill="${BAR_COLORS[ci]}" rx="${rx}" ry="${rx}"/>`;
          svgContent += `<rect x="${bx}" y="${by + rx}" width="${barW}" height="${Math.max(0, barH - rx)}" fill="${BAR_COLORS[ci]}"/>`;
        } else {
          svgContent += `<rect x="${bx}" y="${by}" width="${barW}" height="${barH}" fill="${BAR_COLORS[ci]}"/>`;
        }
        baseY = by;
      });

      // x축 라벨
      const labelStep = n > 15 ? Math.ceil(n / 10) : 1;
      if (i % labelStep === 0 || i === n - 1) {
        svgContent += `<text x="${bx + barW / 2}" y="${H - 8}" text-anchor="middle" fill="var(--text-sub)" font-size="10" font-weight="500">${b.label}</text>`;
      }
    });

    svg.innerHTML = svgContent;
  }

  function renderActivityAverage(points) {
    const card = $('activityAvgCard');
    if (!card) return;

    const totals = { '앉은 시간': 0, '걸은 시간': 0, '운동한 시간': 0, '휴식한 시간': 0 };
    let daysWithData = 0;
    points.forEach((p) => {
      const recs = p.records || (p.record ? [p.record] : []);
      if (recs.length === 0) return;
      const hasAny = recs.some((r) => r && r.activities && r.activities.length > 0);
      if (!hasAny) return;
      daysWithData++;
      recs.forEach((r) => {
        if (!r) return;
        const c = categorizeRecord(r);
        BAR_CATEGORIES.forEach((cat) => { totals[cat] += c[cat]; });
      });
    });

    const fmtHrs = (min) => {
      if (daysWithData === 0) return '0 시간';
      const avg = min / daysWithData;
      const h = avg / 60;
      return h >= 1 ? `${h.toFixed(1)} 시간` : `${Math.round(avg)} 분`;
    };

    $('avgSit').textContent = fmtHrs(totals['앉은 시간']);
    $('avgWalk').textContent = fmtHrs(totals['걸은 시간']);
    $('avgExercise').textContent = fmtHrs(totals['운동한 시간']);
    $('avgRest').textContent = fmtHrs(totals['휴식한 시간']);
  }

  function renderRecentRecords(points) {
    const list = $('recentRecords');
    const valid = points.filter((p) => p.record).reverse(); // 최신부터
    if (valid.length === 0) {
      list.innerHTML = `<div class="record-empty">기록이 없습니다</div>`;
      return;
    }
    const wd = ['일', '월', '화', '수', '목', '금', '토'];
    list.innerHTML = valid.slice(0, 30).map((p) => {
      const r = p.record;
      const score = typeof r.painScore === 'number' ? r.painScore : '-';
      const scoreClass = typeof r.painScore === 'number' ? painScoreColor(r.painScore) : '';
      const totalMin = (r.activities || []).reduce((s, a) => s + a.minutes, 0);
      const meta = [];
      if (totalMin > 0) {
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        meta.push(`활동 ${h > 0 ? h + '시간 ' : ''}${m}분`);
      }
      if (r.period) meta.push('생리 중');
      if (r.note) meta.push(`📝 ${escapeHtml(r.note.slice(0, 30))}${r.note.length > 30 ? '…' : ''}`);
      const m = p.date.getMonth() + 1;
      const d = p.date.getDate();
      return `
        <div class="record-item">
          <div class="record-head">
            <span class="record-date">${m}/${d} (${wd[p.date.getDay()]})${r.period ? '🩸' : ''}</span>
            <span class="record-pain ${scoreClass}">${score === '-' ? '-' : score + '점'}</span>
          </div>
          ${meta.length > 0 ? `<div class="record-meta">${meta.join(' · ')}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // ---- Calendar (Date Picker) ----
  function openCalendar() {
    const parts = healthSelectedDate.split('-');
    calendarMonth = new Date(+parts[0], +parts[1] - 1, 1);
    renderCalendar();
    $('calendarModal').classList.remove('hidden');
  }

  function closeCalendar() {
    $('calendarModal').classList.add('hidden');
  }

  function renderCalendar() {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    $('calMonthLabel').textContent = `${year}년 ${month + 1}월`;

    const records = loadHealthRecords();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = todayKey();

    let html = '';
    for (let i = 0; i < firstDay; i++) {
      html += '<div class="cal-cell empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const rec = records[key];
      const isToday = key === today;
      const isSelected = key === healthSelectedDate;

      let dotHtml = '';
      if (rec && typeof rec.painScore === 'number') {
        dotHtml = `<span class="cal-dot" style="background:${painDotColor(rec.painScore)}"></span>`;
      }

      html += `<div class="cal-cell${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}" data-key="${key}">
        <span class="cal-day">${d}</span>
        ${dotHtml}
      </div>`;
    }

    $('calDays').innerHTML = html;

    document.querySelectorAll('#calDays .cal-cell:not(.empty)').forEach((cell) => {
      cell.addEventListener('click', () => {
        healthSelectedDate = cell.dataset.key;
        loadTodayCheckUI();
        closeCalendar();
      });
    });
  }

  function painDotColor(score) {
    if (score >= 9) return '#5B9BD5';
    if (score >= 7) return '#99cc66';
    if (score >= 5) return '#D4A843';
    if (score >= 3) return '#E8913A';
    return '#D46A6A';
  }

  // ---- Health Event Listeners ----
  function setupHealthListeners() {
    // 하단 탭
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // 서브탭
    document.querySelectorAll('.health-subtab').forEach((btn) => {
      btn.addEventListener('click', () => switchSubtab(btn.dataset.subtab));
    });

    // 통증 슬라이더
    const range = $('painScoreRange');
    range.addEventListener('input', () => {
      const v = parseInt(range.value);
      updatePainDisplay(v);
      // 자동 저장 (실시간)
      const today = getSelectedRecord();
      today.painScore = v;
      saveSelectedRecord(today);
    });

    // 활동 추가
    $('addActivityBtn').addEventListener('click', openActivityModal);
    $('activityModalClose').addEventListener('click', closeActivityModal);
    $('activityModal').addEventListener('click', (e) => {
      if (e.target === $('activityModal')) closeActivityModal();
    });

    // 활동 종류 선택
    document.querySelectorAll('.activity-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.activity-type-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        activityModalState.selectedType = btn.dataset.type;
        $('customTypeGroup').style.display = btn.dataset.type === '기타' ? '' : 'none';
      });
    });

    $('activitySaveBtn').addEventListener('click', commitActivity);

    // 생리 체크
    $('periodCheck').addEventListener('change', () => {
      const today = getSelectedRecord();
      today.period = $('periodCheck').checked;
      saveSelectedRecord(today);
    });

    // 비타민 체크
    document.querySelectorAll('.vitamin-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const today = getSelectedRecord();
        if (!today.vitamins) today.vitamins = {};
        today.vitamins[cb.dataset.key] = cb.checked;
        saveSelectedRecord(today);
      });
    });

    // 메모
    $('checkNote').addEventListener('input', () => {
      const today = getSelectedRecord();
      today.note = $('checkNote').value;
      saveSelectedRecord(today);
    });

    // 저장 버튼
    $('saveCheckBtn').addEventListener('click', saveTodayCheck);

    // 그래프 기간 선택
    document.querySelectorAll('.period-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        graphState.periodType = btn.dataset.period;
        graphState.anchorDate = new Date();
        renderGraph();
      });
    });

    // 날짜 네비게이션
    $('datePrev').addEventListener('click', () => navigateGraph(-1));
    $('dateNext').addEventListener('click', () => navigateGraph(1));

    // 날짜수정 달력
    $('dateEditBtn').addEventListener('click', openCalendar);
    $('calendarClose').addEventListener('click', closeCalendar);
    $('calendarModal').addEventListener('click', (e) => {
      if (e.target === $('calendarModal')) closeCalendar();
    });
    $('calMonthPrev').addEventListener('click', () => {
      calendarMonth.setMonth(calendarMonth.getMonth() - 1);
      renderCalendar();
    });
    $('calMonthNext').addEventListener('click', () => {
      calendarMonth.setMonth(calendarMonth.getMonth() + 1);
      renderCalendar();
    });
    $('calTodayBtn').addEventListener('click', () => {
      healthSelectedDate = todayKey();
      loadTodayCheckUI();
      closeCalendar();
    });

  }

  // --- Init ---
  function init() {
    loadSittingState();

    // Reset day if needed
    const key = todayKey();
    if (key !== state.dayKey) {
      state.totalSittingSeconds = 0;
      state.cycles = 0;
      state.dayKey = key;
      saveSittingState();
    }

    state.remainingSeconds = settings.activityMin * 60;
    updateTimerUI();
    updateSittingUI();
    setPhaseClass('');
    cycleCount.textContent = '';

    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    // Firebase 동기화 자동 연결 (기본 코드: DAHYE)
    initFirebase();
    const savedCode = localStorage.getItem('backTimerSyncCode');
    connectSync(savedCode || 'DAHYE');
    updateSyncUI();

    // 허리 기록 기능 초기화
    setupHealthListeners();

    // 홈 화면 추가 안내 (PWA 미설치 시)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    const installDismissed = localStorage.getItem('installBannerDismissed');
    if (!isStandalone && !installDismissed) {
      $('installBanner').classList.remove('hidden');
    }
    $('installDismiss').addEventListener('click', () => {
      $('installBanner').classList.add('hidden');
      localStorage.setItem('installBannerDismissed', '1');
    });
  }

  init();
})();
