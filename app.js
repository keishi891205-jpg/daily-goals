// File: app.js
"use strict";

(() => {
  const APP_ID = "daily-goals";
  const VERSION = 1;

  // GitHub Pagesの別プロジェクトと保存キーが衝突しないようにする。
  const APP_PATH = new URL(".", window.location.href).pathname;
  const STORAGE_KEY = `${APP_ID}:${APP_PATH}:records:v1`;
  const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

  const $ = (id) => document.getElementById(id);

  const entryDialog = $("entryDialog");
  const helpDialog = $("helpDialog");

  let data = emptyData();
  let rawSnapshot = null;
  let storageReadable = true;
  let readOnly = false;
  let storageProblem = "";

  let viewYear = new Date().getFullYear();
  let viewMonth = new Date().getMonth();
  let editedDate = null;
  let knownToday = todayKey();

  let activeDialog = null;
  let returnFocus = null;
  let returnDate = null;
  let lockedScrollY = 0;

  let importing = false;
  let offlineReady = false;
  let offlineCheckSequence = 0;

  const messageTimers = new Map();

  function emptyData() {
    return {
      app: APP_ID,
      version: VERSION,
      days: {}
    };
  }

  function emptyDay() {
    return {
      wake: null,
      meetings: {
        state: "unset",
        items: []
      }
    };
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function dateKey(date) {
    return [
      String(date.getFullYear()).padStart(4, "0"),
      pad2(date.getMonth() + 1),
      pad2(date.getDate())
    ].join("-");
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function parseDateKey(value) {
    if (typeof value !== "string") {
      return null;
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

    if (!match) {
      return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    if (year < 1000 || year > 9999) {
      return null;
    }

    const date = new Date(year, month - 1, day, 12);

    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }

    return date;
  }

  function isObject(value) {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    );
  }

  function requireKeys(value, expectedKeys, label) {
    if (!isObject(value)) {
      throw new Error(`${label}の形式が正しくありません。`);
    }

    const keys = Object.keys(value);

    if (
      keys.length !== expectedKeys.length ||
      !expectedKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(value, key)
      )
    ) {
      throw new Error(`${label}の項目が正しくありません。`);
    }
  }

  function validateData(value) {
    requireKeys(value, ["app", "version", "days"], "バックアップ");

    if (value.app !== APP_ID || value.version !== VERSION) {
      throw new Error("このアプリの対応するバックアップではありません。");
    }

    if (!isObject(value.days)) {
      throw new Error("日付別データの形式が正しくありません。");
    }

    const normalized = emptyData();
    const ids = new Set();

    for (const [key, day] of Object.entries(value.days)) {
      if (!parseDateKey(key)) {
        throw new Error("存在しない日付が含まれています。");
      }

      requireKeys(day, ["wake", "meetings"], "日付別記録");

      if (![null, "ok", "ng"].includes(day.wake)) {
        throw new Error("起床の値が正しくありません。");
      }

      requireKeys(day.meetings, ["state", "items"], "集合記録");

      const state = day.meetings.state;
      const items = day.meetings.items;

      if (
        !["unset", "none", "recorded"].includes(state) ||
        !Array.isArray(items)
      ) {
        throw new Error("集合の状態が正しくありません。");
      }

      if (
        (state === "recorded" && items.length === 0) ||
        (state !== "recorded" && items.length !== 0)
      ) {
        throw new Error("集合の状態と件数が一致しません。");
      }

      const normalizedItems = [];

      for (const item of items) {
        requireKeys(item, ["id", "result"], "集合の各記録");

        if (
          typeof item.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) ||
          ids.has(item.id)
        ) {
          throw new Error("集合記録の識別子が不正、または重複しています。");
        }

        if (!["ok", "ng"].includes(item.result)) {
          throw new Error("集合の◯×が正しくありません。");
        }

        ids.add(item.id);
        normalizedItems.push({
          id: item.id,
          result: item.result
        });
      }

      normalized.days[key] = {
        wake: day.wake,
        meetings: {
          state,
          items: normalizedItems
        }
      };
    }

    return normalized;
  }

  function readStorage() {
    let raw;

    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      storageReadable = false;
      readOnly = true;
      storageProblem =
        "端末内の保存領域にアクセスできません。記録操作を停止しています。" +
        "ブラウザの設定を確認し、再読み込みしてください。";
      return;
    }

    storageReadable = true;
    rawSnapshot = raw;

    if (raw === null) {
      data = emptyData();
      readOnly = false;
      storageProblem = "";
      return;
    }

    try {
      data = validateData(JSON.parse(raw));
      readOnly = false;
      storageProblem = "";
    } catch {
      data = emptyData();
      readOnly = true;
      storageProblem =
        "保存データを読み取れません。元データは変更していません。" +
        "設定・ヘルプから元データを書き出すか、正常なバックアップを復元してください。";
    }
  }

  function commit(next, allowRestore = false) {
    if (!storageReadable || (readOnly && !allowRestore)) {
      throw new Error("保存領域を確認できないため、変更できません。");
    }

    let actual;

    try {
      actual = localStorage.getItem(STORAGE_KEY);
    } catch {
      throw new Error(
        "保存領域にアクセスできません。変更は保存されていません。"
      );
    }

    if (actual !== rawSnapshot) {
      readStorage();
      renderAll();
      throw new Error(
        "別の画面で記録が変わりました。表示を更新したので、もう一度操作してください。"
      );
    }

    const serialized = JSON.stringify(next);

    try {
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch {
      throw new Error(
        "保存できませんでした。空き容量やブラウザの設定を確認してください。" +
        "今回の変更は反映していません。"
      );
    }

    // 永続化に成功してから、画面用のデータを更新する。
    data = next;
    rawSnapshot = serialized;
    readOnly = false;
    storageProblem = "";
  }

  function cloneData() {
    return JSON.parse(JSON.stringify(data));
  }

  function getDay(key) {
    return data.days[key] || emptyDay();
  }

  function createId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    return Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }

  function makeElement(tag, className = "", text = "") {
    const element = document.createElement(tag);

    if (className) {
      element.className = className;
    }

    if (text !== "") {
      element.textContent = text;
    }

    return element;
  }

  function mark(value) {
    if (value === "ok") {
      return makeElement("span", "ok-text", "◯");
    }

    if (value === "ng") {
      return makeElement("span", "ng-text", "×");
    }

    return makeElement("span", "muted", "・");
  }

  function resultText(value) {
    if (value === "ok") {
      return "達成";
    }

    if (value === "ng") {
      return "未達成";
    }

    return "未入力";
  }

  function calendarLine(label, marks) {
    const line = makeElement("span", "calendar-line");
    const labelElement = makeElement("span", "mini-label", label);
    const values = makeElement("span", "marks");

    values.append(...marks);
    line.append(labelElement, values);

    return line;
  }

  function renderSummary() {
    const prefix = `${String(viewYear).padStart(4, "0")}-${pad2(viewMonth + 1)}-`;

    let wakeTotal = 0;
    let wakeOk = 0;
    let meetingTotal = 0;
    let meetingOk = 0;

    for (const [key, day] of Object.entries(data.days)) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      if (day.wake !== null) {
        wakeTotal += 1;

        if (day.wake === "ok") {
          wakeOk += 1;
        }
      }

      for (const item of day.meetings.items) {
        meetingTotal += 1;

        if (item.result === "ok") {
          meetingOk += 1;
        }
      }
    }

    $("wakeRate").textContent = wakeTotal
      ? `${Math.round((wakeOk / wakeTotal) * 100)}％`
      : "未集計";

    $("meetingRate").textContent = meetingTotal
      ? `${Math.round((meetingOk / meetingTotal) * 100)}％`
      : "未集計";

    $("wakeCount").textContent = `${wakeOk}日／${wakeTotal}日`;
    $("meetingCount").textContent = `${meetingOk}回／${meetingTotal}回`;
  }

  function renderCalendar() {
    $("monthTitle").textContent = `${viewYear}年${viewMonth + 1}月`;

    $("previousMonth").disabled = viewYear === 1000 && viewMonth === 0;
    $("nextMonth").disabled = viewYear === 9999 && viewMonth === 11;

    const calendar = $("calendar");
    const fragment = document.createDocumentFragment();

    const first = new Date(viewYear, viewMonth, 1, 12);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0, 12).getDate();
    const cells = Math.ceil((offset + daysInMonth) / 7) * 7;
    const today = todayKey();

    for (let position = 0; position < cells; position += 1) {
      const dayNumber = position - offset + 1;

      if (dayNumber < 1 || dayNumber > daysInMonth) {
        const empty = makeElement("div", "empty-day");
        empty.setAttribute("aria-hidden", "true");
        fragment.append(empty);
        continue;
      }

      const key = dateKey(new Date(viewYear, viewMonth, dayNumber, 12));
      const day = getDay(key);
      const button = makeElement("button", "day");

      button.type = "button";
      button.dataset.date = key;
      button.disabled = key > today;

      if (key === today) {
        button.classList.add("today");
        button.setAttribute("aria-current", "date");
      }

      button.append(
        makeElement("span", "day-number", String(dayNumber)),
        calendarLine("起", [mark(day.wake)])
      );

      let meetingDescription;

      if (day.meetings.state === "none") {
        button.append(
          calendarLine("集", [makeElement("span", "muted", "―")])
        );
        meetingDescription = "集合なし";
      } else if (day.meetings.state === "unset") {
        button.append(calendarLine("集", [mark(null)]));
        meetingDescription = "集合未入力";
      } else {
        const items = day.meetings.items;
        const okCount = items.filter((item) => item.result === "ok").length;

        button.append(
          calendarLine(
            "集",
            items.slice(0, 3).map((item) => mark(item.result))
          )
        );

        if (items.length > 3) {
          button.append(
            makeElement("span", "extra-count", `＋${items.length - 3}`)
          );
        }

        meetingDescription =
          `集合${items.length}回、達成${okCount}回`;
      }

      button.setAttribute(
        "aria-label",
        `${viewYear}年${viewMonth + 1}月${dayNumber}日、` +
        `起床${resultText(day.wake)}、${meetingDescription}` +
        (key > today ? "、未来の日付は入力できません" : "")
      );

      fragment.append(button);
    }

    calendar.replaceChildren(fragment);
  }

  function createItemButton(text, action, item, index, className) {
    const button = makeElement("button", className, text);

    button.type = "button";
    button.dataset.action = action;
    button.dataset.itemId = item.id;
    button.dataset.focusKey = `${item.id}:${action}`;

    if (action === "delete") {
      button.setAttribute("aria-label", `${index + 1}回目の記録を削除`);
    } else {
      button.setAttribute(
        "aria-label",
        `${index + 1}回目を${action === "ok" ? "達成" : "未達成"}にする`
      );
      button.setAttribute(
        "aria-pressed",
        String(item.result === action)
      );
    }

    return button;
  }

  function renderEditor() {
    if (!editedDate) {
      return;
    }

    const date = parseDateKey(editedDate);

    $("entryTitle").textContent = new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short"
    }).format(date);

    const day = getDay(editedDate);
    const isFuture = editedDate > todayKey();

    $("entryFields").disabled = readOnly || isFuture;
    $("entryRestriction").hidden = !isFuture;
    $("entryRestriction").textContent =
      "端末の日付変更などにより、未来の日付になりました。入力はできません。";

    document.querySelectorAll("[data-wake]").forEach((button) => {
      const value = button.dataset.wake === "unset"
        ? null
        : button.dataset.wake;

      button.setAttribute("aria-pressed", String(day.wake === value));
    });

    const meetings = day.meetings;

    if (meetings.state === "none") {
      $("meetingState").textContent = "この日は集合の予定なし";
    } else if (meetings.state === "unset") {
      $("meetingState").textContent = "未入力";
    } else {
      $("meetingState").textContent = `${meetings.items.length}回を記録済み`;
    }

    $("noMeetings").setAttribute(
      "aria-pressed",
      String(meetings.state === "none")
    );

    $("clearMeetings").setAttribute(
      "aria-pressed",
      String(meetings.state === "unset")
    );

    const fragment = document.createDocumentFragment();

    meetings.items.forEach((item, index) => {
      const row = makeElement("li", "meeting-item");
      const label = makeElement("span", "meeting-label", `${index + 1}回目`);
      const actions = makeElement("div", "meeting-actions");

      actions.append(
        createItemButton("◯", "ok", item, index, "ok-choice"),
        createItemButton("×", "ng", item, index, "ng-choice"),
        createItemButton("削除", "delete", item, index, "delete-button")
      );

      row.append(label, actions);
      fragment.append(row);
    });

    $("meetingList").replaceChildren(fragment);
  }

  function renderWarnings() {
    document.querySelectorAll(".storage-warning").forEach((element) => {
      element.hidden = !storageProblem;
      element.textContent = storageProblem;
    });

    $("exportButton").disabled = !storageReadable;
    $("exportButton").textContent = readOnly
      ? "読み取れない元データを書き出す"
      : "全記録を書き出す";

    $("importButton").disabled = !storageReadable || importing;
    $("importButton").textContent = importing
      ? "確認しています…"
      : "バックアップを読み込む";
  }

  function renderAll() {
    const focusKey = document.activeElement?.dataset?.focusKey;

    renderSummary();
    renderCalendar();
    renderEditor();
    renderWarnings();

    if (focusKey && entryDialog.open) {
      const target = Array.from(
        $("meetingList").querySelectorAll("[data-focus-key]")
      ).find((element) => element.dataset.focusKey === focusKey);

      (target || $("addMeetingOk")).focus({ preventScroll: true });
    }
  }

  function clearMessage(element) {
    clearTimeout(messageTimers.get(element.id));
    element.textContent = "";
    element.classList.remove("error");
  }

  function announce(text, isError = false) {
    const target = activeDialog === entryDialog
      ? $("entryMessage")
      : activeDialog === helpDialog
        ? $("helpMessage")
        : $("mainMessage");

    clearMessage(target);
    target.textContent = text;
    target.classList.toggle("error", isError);

    if (!isError) {
      messageTimers.set(
        target.id,
        setTimeout(() => clearMessage(target), 3500)
      );
    }
  }

  function openSheet(dialog, opener) {
    if (activeDialog) {
      return;
    }

    returnFocus = opener || document.activeElement;
    returnDate = returnFocus?.dataset?.date || null;
    lockedScrollY = window.scrollY;
    activeDialog = dialog;

    document.body.style.position = "fixed";
    document.body.style.top = `-${lockedScrollY}px`;
    document.body.style.width = "100%";

    clearMessage(
      dialog === entryDialog ? $("entryMessage") : $("helpMessage")
    );

    dialog.showModal();
    dialog.querySelector("[data-close]").focus({ preventScroll: true });
  }

  function handleDialogClose() {
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, lockedScrollY);

    activeDialog = null;
    editedDate = null;

    let target = returnFocus;

    if (!target || !target.isConnected || target.disabled) {
      target = returnDate
        ? Array.from(
            $("calendar").querySelectorAll("[data-date]")
          ).find((element) => element.dataset.date === returnDate)
        : null;
    }

    if (!target || target.disabled) {
      target = $("todayButton");
    }

    target.focus({ preventScroll: true });
  }

  function openEntry(key, opener) {
    refreshDayBoundary();

    if (!parseDateKey(key) || key > todayKey()) {
      return;
    }

    editedDate = key;
    renderEditor();
    openSheet(entryDialog, opener);
  }

  function updateDay(mutator) {
    refreshDayBoundary();

    if (!editedDate || editedDate > todayKey()) {
      announce("未来の日付には入力できません。", true);
      return;
    }

    if (readOnly) {
      announce("保存データを確認できないため、記録操作を停止しています。", true);
      return;
    }

    try {
      const next = cloneData();
      const day = next.days[editedDate] || emptyDay();

      mutator(day);

      if (day.wake === null && day.meetings.state === "unset") {
        delete next.days[editedDate];
      } else {
        next.days[editedDate] = day;
      }

      commit(next);
      renderAll();
      announce("保存しました");
    } catch (error) {
      renderAll();
      announce(error.message || "保存できませんでした。", true);
    }
  }

  function addMeeting(result) {
    updateDay((day) => {
      day.meetings.state = "recorded";
      day.meetings.items.push({
        id: createId(),
        result
      });
    });
  }

  function setMeetingState(state) {
    if (!editedDate) {
      return;
    }

    const day = getDay(editedDate);

    if (
      day.meetings.items.length > 0 &&
      !window.confirm(
        "この日の集合記録をすべて削除して変更します。よろしいですか？"
      )
    ) {
      return;
    }

    updateDay((nextDay) => {
      nextDay.meetings = {
        state,
        items: []
      };
    });
  }

  function changeMonth(amount) {
    const total = viewYear * 12 + viewMonth + amount;
    const year = Math.floor(total / 12);

    if (year < 1000 || year > 9999) {
      return;
    }

    viewYear = year;
    viewMonth = ((total % 12) + 12) % 12;
    renderAll();
  }

  function refreshDayBoundary() {
    const current = todayKey();

    if (current !== knownToday) {
      knownToday = current;
      renderAll();
    }
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], {
      type: "application/json;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;

    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    // iOSなどでダウンロード開始前にURLが失効しないよう猶予を設ける。
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function exportBackup() {
    if (!storageReadable) {
      announce("保存領域にアクセスできません。", true);
      return;
    }

    try {
      const now = new Date();
      const suffix =
        `${dateKey(now)}-${pad2(now.getHours())}` +
        `${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

      if (readOnly) {
        downloadText(
          rawSnapshot ?? "",
          `daily-goals-unchecked-${suffix}.json`
        );

        announce(
          "元データの書き出しを開始しました。未検証のため、そのまま復元できるとは限りません。"
        );
        return;
      }

      downloadText(
        JSON.stringify(data, null, 2),
        `daily-goals-backup-${suffix}.json`
      );

      announce("書き出しを開始しました。ダウンロード先を確認してください。");
    } catch {
      announce("書き出しを開始できませんでした。", true);
    }
  }

  async function importBackup(file) {
    if (!file || importing) {
      return;
    }

    if (file.size > MAX_IMPORT_BYTES) {
      announce("10MB以下のバックアップを選んでください。", true);
      return;
    }

    importing = true;
    const startingSnapshot = rawSnapshot;
    renderWarnings();

    try {
      const text = await file.text();
      let parsed;

      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("JSONとして読み取れないファイルです。");
      }

      const next = validateData(parsed);

      if (rawSnapshot !== startingSnapshot) {
        throw new Error(
          "読み込み中に記録が変わりました。もう一度ファイルを選んでください。"
        );
      }

      const count = Object.keys(next.days).length;

      if (
        !window.confirm(
          `${count}日分のバックアップで、端末内の全記録を置き換えます。\n` +
          "この操作では現在の記録との統合は行いません。\n" +
          "置き換えてよろしいですか？"
        )
      ) {
        return;
      }

      commit(next, true);
      renderAll();
      announce("バックアップを復元しました");
    } catch (error) {
      announce(error.message || "バックアップを読み込めませんでした。", true);
    } finally {
      importing = false;
      $("importFile").value = "";
      renderWarnings();
    }
  }

  function paintOfflineStatus() {
    if (offlineReady) {
      $("offlineStatus").textContent = navigator.onLine
        ? "オフライン利用可"
        : "オフラインで利用中";
    } else {
      $("offlineStatus").textContent = navigator.onLine
        ? "オフライン未準備：通信やファイルの配置を確認してください"
        : "オフライン未準備：オンラインで開き直してください";
    }
  }

  function askCacheReady(worker) {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      let finished = false;

      const finish = (value) => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timer);
        channel.port1.close();
        resolve(value);
      };

      const timer = setTimeout(() => finish(false), 5000);

      channel.port1.onmessage = (event) => {
        finish(event.data?.ready === true);
      };

      try {
        worker.postMessage(
          { type: "CHECK_OFFLINE" },
          [channel.port2]
        );
      } catch {
        finish(false);
      }
    });
  }

  async function refreshOfflineStatus() {
    const sequence = ++offlineCheckSequence;
    const worker = navigator.serviceWorker?.controller;
    const ready = worker ? await askCacheReady(worker) : false;

    if (sequence !== offlineCheckSequence) {
      return;
    }

    offlineReady = ready;
    paintOfflineStatus();
  }

  async function setupPwa() {
    if (
      !("serviceWorker" in navigator) ||
      !window.isSecureContext ||
      window.location.protocol === "file:"
    ) {
      $("offlineStatus").textContent =
        "PWA機能にはHTTPSまたはlocalhostでのアクセスが必要です";
      return;
    }

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      refreshOfflineStatus
    );

    try {
      const registration = await navigator.serviceWorker.register(
        "./sw.js",
        {
          scope: "./",
          updateViaCache: "none"
        }
      );

      const showWaiting = () => {
        $("updateNotice").hidden = !registration.waiting;
      };

      const watchInstalling = () => {
        const worker = registration.installing;

        if (!worker) {
          return;
        }

        worker.addEventListener("statechange", () => {
          if (worker.state === "installed") {
            showWaiting();
            refreshOfflineStatus();
          }

          if (
            worker.state === "redundant" &&
            !navigator.serviceWorker.controller
          ) {
            offlineReady = false;
            paintOfflineStatus();
          }
        });
      };

      registration.addEventListener("updatefound", watchInstalling);
      watchInstalling();
      showWaiting();

      // 初回インストールが失敗した場合も、準備中表示を放置しない。
      setTimeout(() => {
        if (!navigator.serviceWorker.controller) {
          paintOfflineStatus();
        }
      }, 12000);

      await navigator.serviceWorker.ready;
      await refreshOfflineStatus();
    } catch {
      offlineReady = false;
      paintOfflineStatus();
    }
  }

  $("previousMonth").addEventListener("click", () => changeMonth(-1));
  $("nextMonth").addEventListener("click", () => changeMonth(1));

  $("currentMonth").addEventListener("click", () => {
    const now = new Date();
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();
    refreshDayBoundary();
    renderAll();
  });

  $("calendar").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-date]");

    if (button && !button.disabled) {
      openEntry(button.dataset.date, button);
    }
  });

  $("todayButton").addEventListener("click", () => {
    openEntry(todayKey(), $("todayButton"));
  });

  $("helpButton").addEventListener("click", () => {
    renderWarnings();
    openSheet(helpDialog, $("helpButton"));
  });

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => {
      $(button.dataset.close).close();
    });
  });

  entryDialog.addEventListener("close", handleDialogClose);
  helpDialog.addEventListener("close", handleDialogClose);

  document.querySelectorAll("[data-wake]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.wake === "unset"
        ? null
        : button.dataset.wake;

      updateDay((day) => {
        day.wake = value;
      });
    });
  });

  $("addMeetingOk").addEventListener("click", () => addMeeting("ok"));
  $("addMeetingNg").addEventListener("click", () => addMeeting("ng"));
  $("noMeetings").addEventListener("click", () => setMeetingState("none"));
  $("clearMeetings").addEventListener("click", () => setMeetingState("unset"));

  $("meetingList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-item-id]");

    if (!button) {
      return;
    }

    const id = button.dataset.itemId;
    const action = button.dataset.action;

    updateDay((day) => {
      const index = day.meetings.items.findIndex((item) => item.id === id);

      if (index < 0) {
        throw new Error("対象の記録が見つかりません。もう一度操作してください。");
      }

      if (action === "delete") {
        day.meetings.items.splice(index, 1);

        if (day.meetings.items.length === 0) {
          day.meetings.state = "unset";
        }
      } else if (action === "ok" || action === "ng") {
        day.meetings.items[index].result = action;
      }
    });
  });

  $("exportButton").addEventListener("click", exportBackup);

  $("importButton").addEventListener("click", () => {
    $("importFile").value = "";
    $("importFile").click();
  });

  $("importFile").addEventListener("change", () => {
    importBackup($("importFile").files?.[0]);
  });

  $("reloadButton").addEventListener("click", () => {
    window.location.reload();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      readStorage();
      renderAll();
      announce("別の画面での変更を読み込みました");
    }
  });

  window.addEventListener("focus", refreshDayBoundary);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshDayBoundary();

      if (
        "serviceWorker" in navigator &&
        window.isSecureContext &&
        window.location.protocol !== "file:"
      ) {
        refreshOfflineStatus();
      }
    }
  });

  window.addEventListener("online", () => {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      refreshOfflineStatus();
    }
  });

  window.addEventListener("offline", paintOfflineStatus);

  setInterval(() => {
    if (!document.hidden) {
      refreshDayBoundary();
    }
  }, 30000);

  readStorage();
  renderAll();
  setupPwa();
})();