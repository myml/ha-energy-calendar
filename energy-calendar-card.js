/**
 * energy-calendar-card
 *
 * A month calendar of daily energy consumption (and cost) for cumulative
 * energy sensors, built on Home Assistant long-term statistics.
 *
 * The card asks `recorder/statistics_during_period` for one `day` bucket per
 * day, so the daily figures match the Energy dashboard exactly.
 *
 * Configuration:
 *   entities:
 *     - entity: sensor.esp32_c5_2_pzem_energy   # cumulative energy sensor
 *       name: 总用电                              # optional label
 *   price: 0.58                                  # optional, currency per kWh
 *   currency: CNY                                # optional symbol/ISO code
 *   show_cost: true                              # defaults to price !== null
 *   unit: kWh                                    # display unit
 *   decimals: 2
 *   week_start: monday | sunday
 *   tint: true                                   # heat shading for every day
 *   max_color / min_color / accent_color
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const CARD_VERSION = "0.2.0";

const MONTH_NAMES = [
  "1月", "2月", "3月", "4月", "5月", "6月",
  "7月", "8月", "9月", "10月", "11月", "12月",
];

const WEEKDAYS = {
  monday: ["一", "二", "三", "四", "五", "六", "日"],
  sunday: ["日", "一", "二", "三", "四", "五", "六"],
};

/* Energy sensors report Wh, kWh, MWh, GJ...; normalise everything to kWh. */
const TO_KWH = {
  wh: 0.001,
  kwh: 1,
  mwh: 1000,
  gj: 277.7777778,
  mj: 0.2777777778,
  kj: 0.0002777777778,
};

const pad = (n) => String(n).padStart(2, "0");

const ymd = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toKwh(value, unit) {
  if (value === null || value === undefined) return null;
  const factor = TO_KWH[String(unit || "").trim().toLowerCase()];
  return Number.isFinite(factor) ? value * factor : null;
}

/** Trim trailing zeros so 7.10 renders as "7.1" while 7.09 stays "7.09". */
function formatValue(value, decimals) {
  return Number(Number(value).toFixed(decimals)).toString();
}

/** Mix a hex colour toward the card background, for chips and badges. */
function tint(hex, ratio, dark) {
  const base = dark ? [28, 31, 36] : [255, 255, 255];
  const clean = hex.replace("#", "");
  const target = [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
  const mixed = target.map((c, i) => Math.round(c * ratio + base[i] * (1 - ratio)));
  return `rgb(${mixed.join(", ")})`;
}

/**
 * Heat colour for a day, as an hsl ramp so the shades stay saturated instead of
 * turning grey. `ratio` is 0 (the month's quietest day) .. 1 (its busiest).
 */
function heatColor(hex, ratio, dark) {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  // Lightness runs from near-background to a solid brand tone.
  const lightness = dark ? 0.20 + 0.16 * ratio : 0.94 - 0.30 * ratio;
  const saturation = dark ? 0.38 + 0.22 * ratio : 0.42 + 0.30 * ratio;
  return `hsl(${h.toFixed(0)} ${(saturation * 100).toFixed(0)}% ${(lightness * 100).toFixed(0)}%)`;
}

class EnergyCalendarCard extends HTMLElement {
  static getStubConfig(hass) {
    const entity = Object.keys(hass.states).find((id) => {
      const attrs = hass.states[id].attributes;
      return attrs.device_class === "energy" && attrs.state_class === "total_increasing";
    });
    return { entities: entity ? [{ entity }] : [] };
  }

  static async getConfigElement() {
    return document.createElement("energy-calendar-card-editor");
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._cache = new Map();
    this._month = startOfDay(new Date());
    this._selected = startOfDay(new Date());
    this._timer = null;
    this._error = null;
    this._animate = false;
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.entities) || config.entities.length === 0) {
      throw new Error("请至少配置一个 energy 实体");
    }
    this._config = {
      price: null,
      currency: "¥",
      show_cost: undefined,
      unit: "kWh",
      decimals: 2,
      week_start: "monday",
      tint: true,
      max_color: "#ff6259",
      min_color: "#3d7bfd",
      accent_color: "#0fa47f",
      title: undefined,
      ...config,
      entities: config.entities.map((e) => (typeof e === "string" ? { entity: e } : e)),
    };
    this._month = startOfDay(new Date());
    this._selected = startOfDay(new Date());
    this._cache.clear();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._subscribed) {
      this._subscribed = true;
      this._load();
      this._timer = setInterval(() => this._load(true), POLL_INTERVAL_MS);
    }
  }

  disconnectedCallback() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getCardSize() {
    return 8;
  }

  _statisticIds() {
    return this._config.entities.map((e) => e.entity);
  }

  _price() {
    if (typeof this._config.price === "number") return this._config.price;
    const first = this._config.entities[0];
    return first && typeof first.price === "number" ? first.price : null;
  }

  _showCost() {
    if (this._config.show_cost !== undefined) return this._config.show_cost;
    return this._price() !== null;
  }

  async _load(force = false) {
    if (!this._hass || !this._config) return;

    const year = this._month.getFullYear();
    const month = this._month.getMonth();
    const first = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const key = ymd(first);

    // A month already fully in the past never changes again.
    if (!force && this._cache.has(key) && lastDay < startOfDay(new Date())) {
      return;
    }

    const start = new Date(year, month, 1);
    const end = new Date(year, month, lastDay.getDate() + 1);

    try {
      const result = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: this._statisticIds(),
        period: "day",
        types: ["change", "state"],
      });
      this._cache.set(key, result);
      this._error = null;
      this._render();
    } catch (err) {
      console.warn("energy-calendar-card: statistics query failed", err);
      this._error = `读取统计数据失败：${err.message || err}`;
      this._render();
    }
  }

  /** Fold the statistics answer into { "YYYY-MM-DD": kWh }. */
  _dailyKwh(periodKey) {
    const result = this._cache.get(periodKey);
    const totals = new Map();
    if (!result) return totals;

    for (const [statId, buckets] of Object.entries(result)) {
      const configured = this._config.entities.find((e) => e.entity === statId) || {};
      const unit =
        configured.unit ||
        this._hass?.states?.[statId]?.attributes?.unit_of_measurement ||
        "kWh";

      for (const bucket of buckets || []) {
        const raw = bucket.change ?? bucket.state ?? null;
        let kwh = toKwh(raw, unit);
        if (kwh === null) continue;
        if (typeof configured.multiplier === "number") kwh *= configured.multiplier;
        // Negative deltas come from meter resets or restores; ignore them.
        if (kwh < 0) continue;
        const dayKey = ymd(new Date(bucket.start));
        totals.set(dayKey, (totals.get(dayKey) || 0) + kwh);
      }
    }
    return totals;
  }

  _render() {
    if (!this._config) return;

    const { unit, decimals, currency } = this._config;
    const price = this._price();
    const showCost = this._showCost() && price !== null;
    const weekStart = this._config.week_start === "sunday" ? "sunday" : "monday";

    const dark = this._hass?.themes?.darkMode ?? false;

    const year = this._month.getFullYear();
    const month = this._month.getMonth();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = startOfDay(new Date());

    const daily = this._dailyKwh(ymd(firstDay));
    const values = [...daily.values()].filter((v) => v > 0);
    const maxValue = values.length ? Math.max(...values) : null;
    const minValue = values.length ? Math.min(...values) : null;
    const hasRange = maxValue !== null && maxValue !== minValue;

    const jsDay = firstDay.getDay();
    const offset = weekStart === "monday" ? (jsDay + 6) % 7 : jsDay;

    const cells = [];
    for (let i = 0; i < offset; i += 1) {
      cells.push('<div class="cell empty"></div>');
    }

    let monthTotal = 0;
    let peakKey = null;
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month, day);
      const key = ymd(date);
      const value = daily.get(key);
      const isFuture = date > today;
      const isToday = sameDay(date, today);
      const isSelected = sameDay(date, this._selected);

      if (value !== undefined) {
        monthTotal += value;
        if (peakKey === null || value > (daily.get(peakKey) || 0)) peakKey = key;
      }

      const classes = ["cell"];
      if (value !== undefined) classes.push("has-value");
      if (isFuture) classes.push("future");
      if (isToday) classes.push("today");
      if (isSelected) classes.push("selected");
      if (hasRange && value !== undefined && value === maxValue) classes.push("max");
      if (hasRange && value !== undefined && value === minValue) classes.push("min");

      // Heat tint: scale each day between the month's low and high so small
      // differences stay readable; days at the extremes get their own colour.
      let style = "";
      if (
        this._config.tint &&
        !isFuture &&
        value !== undefined &&
        value > 0 &&
        !classes.includes("max") &&
        !classes.includes("min")
      ) {
        const low = minValue ?? 0;
        const span = (maxValue ?? value) - low;
        const ratio = span > 0 ? (value - low) / span : 0.5;
        // 0.14 -> 0.62 keeps neighbouring days visibly apart.
        const color = ratio >= 0.66 ? "#ffffff" : "var(--ec-text)";
        style =
          `style="background:${heatColor(this._config.accent_color, ratio, dark)};` +
          `color:${color}"`;
      }
      if (classes.includes("max")) style = `style="background:${this._config.max_color}"`;
      if (classes.includes("min")) style = `style="background:${this._config.min_color}"`;

      const amount = value === undefined ? "" : formatValue(value, decimals);
      const cost =
        value !== undefined && showCost
          ? `${currency}${(value * price).toFixed(2)}`
          : "";

      cells.push(`
        <div class="${classes.join(" ")}" data-date="${key}" role="button" tabindex="0"
             ${style} aria-label="${key}：${amount || 0} ${unit}">
          <span class="day">${day}</span>
          <span class="value">${amount}</span>
          ${cost ? `<span class="cost">${cost}</span>` : ""}
        </div>`);
    }

    const trailing = (7 - ((offset + daysInMonth) % 7)) % 7;
    for (let i = 0; i < trailing; i += 1) {
      cells.push('<div class="cell empty"></div>');
    }

    const selectedKey = ymd(this._selected);
    const selectedValue = daily.get(selectedKey);
    const inMonth =
      this._selected.getFullYear() === year && this._selected.getMonth() === month;
    const todayValue = daily.get(ymd(today));

    const detail =
      inMonth && selectedValue !== undefined
        ? `<b>${selectedKey}</b> 用电 <b>${formatValue(selectedValue, decimals)} ${unit}</b>` +
          (showCost ? ` · 电费 <b>${currency}${(selectedValue * price).toFixed(2)}</b>` : "")
        : "点击日期查看当天用电";

    const title = this._config.title || `${year}年 ${MONTH_NAMES[month]}`;
    const weekdayNames = WEEKDAYS[weekStart];

    const avg =
      values.length > 0
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;

    const animateClass = this._animate ? "animate" : "";
    this._animate = false;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --ec-surface: var(--ha-card-background, var(--card-background-color, #fff));
          --ec-text: var(--primary-text-color, #212121);
          --ec-muted: var(--secondary-text-color, #727272);
          --ec-line: var(--divider-color, rgba(0,0,0,.08));
          --ec-hover: var(--secondary-background-color, rgba(0,0,0,.05));
          --ec-empty: ${dark ? "rgba(255,255,255,.025)" : "rgba(0,0,0,.022)"};
          --ec-edge: ${dark ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.09)"};
        }
        ha-card {
          padding: 20px 18px 16px;
          overflow: hidden;
          background: var(--ec-surface);
          color: var(--ec-text);
        }

        /* ---- header ---- */
        .header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 4px;
        }
        .title {
          font-size: 20px; font-weight: 600; letter-spacing: .2px;
          color: var(--ec-text); line-height: 1.2;
        }
        .subtitle {
          font-size: 12px; color: var(--ec-muted); margin-top: 3px; letter-spacing: .2px;
        }
        .nav { display: flex; gap: 2px; align-items: center; }
        .nav button {
          border: none; cursor: pointer; height: 30px; min-width: 30px;
          padding: 0 9px; border-radius: 15px; font-size: 16px; line-height: 1;
          background: transparent; color: var(--ec-muted);
          transition: background .15s ease, color .15s ease;
        }
        .nav button:hover { background: var(--ec-hover); color: var(--ec-text); }
        .nav button.today {
          font-size: 12px; font-weight: 500; letter-spacing: .3px;
          background: var(--ec-hover); color: var(--ec-text);
        }

        /* ---- hero total ---- */
        .hero {
          display: flex; align-items: baseline; gap: 8px;
          margin: 14px 0 16px; flex-wrap: wrap;
        }
        .hero .amount {
          font-size: 32px; font-weight: 650; letter-spacing: -1px;
          line-height: 1; color: var(--ec-text);
          font-variant-numeric: tabular-nums;
        }
        .hero .caption {
          font-size: 12px; color: var(--ec-muted); letter-spacing: .2px;
        }
        .hero .cost {
          margin-left: auto; font-size: 14px; font-weight: 600;
          color: ${this._config.accent_color};
          background: ${tint(this._config.accent_color, dark ? 0.20 : 0.10, dark)};
          padding: 5px 12px; border-radius: 14px; line-height: 1;
          font-variant-numeric: tabular-nums;
        }

        /* ---- calendar ---- */
        .grid {
          display: grid; grid-template-columns: repeat(7, 1fr);
          gap: 5px; margin-top: 2px;
        }
        .weekday {
          text-align: center; font-size: 11px; font-weight: 500;
          color: var(--ec-muted); padding-bottom: 5px; letter-spacing: .8px;
        }
        .cell {
          position: relative; min-height: 62px; border-radius: 11px;
          padding: 6px 7px 6px; display: flex; flex-direction: column;
          cursor: pointer; box-sizing: border-box; overflow: hidden;
          transition: transform .12s ease, box-shadow .16s ease, background .2s ease;
        }
        .cell.has-value {
          box-shadow: 0 1px 2px rgba(0,0,0,.05);
        }
        .cell.empty { background: none; cursor: default; }

        /* Days without data yet (later this month) stay quiet: just a hairline. */
        .cell.future {
          background: transparent; cursor: default;
          box-shadow: inset 0 0 0 1px var(--ec-edge);
          opacity: .55;
        }

        .cell:not(.empty):not(.future):hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 14px rgba(0,0,0,.14);
        }

        /* Today: a soft accent ring instead of a heavy black border. */
        .cell.today {
          box-shadow: inset 0 0 0 2px ${this._config.accent_color};
        }
        .cell.today::before {
          content: ""; position: absolute; top: 6px; right: 6px;
          width: 5px; height: 5px; border-radius: 50%;
          background: ${this._config.accent_color};
        }

        .cell.selected {
          box-shadow: 0 0 0 2px ${this._config.accent_color}, 0 4px 14px rgba(0,0,0,.10);
          z-index: 1;
        }
        /* The selected day already has a ring; keep today's ring from fighting it. */
        .cell.selected.today { box-shadow: 0 0 0 2px ${this._config.accent_color}, 0 4px 14px rgba(0,0,0,.10); }

        .cell.max, .cell.min { color: #fff; }
        .cell.max .day, .cell.min .day { color: rgba(255,255,255,.8); }
        .cell.max .value, .cell.min .value { color: #fff; }
        .cell.max .cost, .cell.min .cost { color: rgba(255,255,255,.82); }

        .day {
          font-size: 11.5px; color: var(--ec-muted); line-height: 1;
          font-variant-numeric: tabular-nums;
        }
        .value {
          font-size: 14.5px; font-weight: 600; margin-top: auto;
          line-height: 1.25; letter-spacing: -.2px;
          color: var(--ec-text); font-variant-numeric: tabular-nums;
        }
        .cost {
          font-size: 10px; color: var(--ec-muted); line-height: 1.15;
          font-variant-numeric: tabular-nums; opacity: .9;
        }

        .cell.stagger { animation: rise .34s cubic-bezier(.22,.61,.36,1) both; }
        @keyframes rise {
          from { opacity: 0; transform: translateY(6px) scale(.98); }
          to { opacity: 1; transform: none; }
        }

        /* ---- stats ---- */
        .stats {
          display: grid; grid-template-columns: repeat(3, 1fr);
          gap: 8px; margin-top: 16px;
        }
        .stat {
          background: var(--ec-hover); border-radius: 11px;
          padding: 9px 11px; display: flex; flex-direction: column; gap: 3px;
        }
        .stat .k { font-size: 11px; color: var(--ec-muted); letter-spacing: .2px; }
        .stat .v {
          font-size: 15px; font-weight: 600; color: var(--ec-text);
          font-variant-numeric: tabular-nums; line-height: 1.2;
        }
        .stat .v small { font-size: 10.5px; font-weight: 400; color: var(--ec-muted); }

        /* ---- footer ---- */
        .detail {
          margin-top: 14px; padding-top: 11px; border-top: 1px solid var(--ec-line);
          font-size: 12.5px; color: var(--ec-muted);
        }
        .detail b { color: var(--ec-text); font-weight: 600; font-variant-numeric: tabular-nums; }
        .legend {
          display: flex; gap: 14px; flex-wrap: wrap; margin-top: 9px;
          font-size: 11px; color: var(--ec-muted); align-items: center;
        }
        .legend span { display: inline-flex; align-items: center; gap: 5px; }
        .dot { width: 10px; height: 10px; border-radius: 3px; }
        .error { color: var(--error-color, #e5484d); font-size: 12px; margin-top: 8px; }

        @media (max-width: 420px) {
          ha-card { padding: 16px 13px 13px; }
          .cell { min-height: 54px; padding: 5px; border-radius: 9px; }
          .value { font-size: 13px; }
          .cost { font-size: 9.5px; }
          .hero .amount { font-size: 26px; }
          .title { font-size: 18px; }
        }
      </style>
      <ha-card class="${animateClass}">
        <div class="header">
          <div>
            <div class="title">${title}</div>
            <div class="subtitle">${showCost ? `电价 ${currency}${price} / ${unit}` : `单位 ${unit}`}</div>
          </div>
          <div class="nav">
            <button data-nav="prev" aria-label="上个月">‹</button>
            <button data-nav="today" class="today" aria-label="回到今天">今天</button>
            <button data-nav="next" aria-label="下个月">›</button>
          </div>
        </div>

        <div class="hero">
          <span class="amount">${monthTotal.toFixed(1)}</span>
          <span class="unit">${unit} 本月累计</span>
          ${showCost ? `<span class="cost">${currency}${(monthTotal * price).toFixed(2)}</span>` : ""}
        </div>

        <div class="grid">
          ${weekdayNames.map((w) => `<div class="weekday">${w}</div>`).join("")}
          ${cells.join("")}
        </div>

        <div class="stats">
          <div class="stat">
            <span class="k">日均</span>
            <span class="v">${avg.toFixed(1)} <small>${unit}</small></span>
          </div>
          <div class="stat">
            <span class="k">本月最高</span>
            <span class="v">${maxValue !== null ? maxValue.toFixed(1) : "-"} <small>${unit}</small></span>
          </div>
          <div class="stat">
            <span class="k">今日</span>
            <span class="v">${todayValue !== undefined ? todayValue.toFixed(1) : "-"} <small>${unit}</small></span>
          </div>
        </div>

        <div class="detail">${detail}</div>

        <div class="legend">
          <span><i class="dot" style="background:${this._config.max_color}"></i>最高</span>
          <span><i class="dot" style="background:${this._config.min_color}"></i>最低</span>
          ${this._config.tint ? `<span><i class="dot" style="background:${heatColor(this._config.accent_color, 0.55, dark)}"></i>用电量越高颜色越深</span>` : ""}
        </div>

        ${this._error ? `<div class="error">${this._error}</div>` : ""}
      </ha-card>
    `;

    this.shadowRoot.querySelectorAll("[data-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.nav;
        if (action === "prev") {
          this._month = new Date(year, month - 1, 1);
        } else if (action === "next") {
          this._month = new Date(year, month + 1, 1);
        } else {
          this._month = startOfDay(new Date());
          this._selected = startOfDay(new Date());
        }
        this._animate = true;
        this._render();
        this._load();
      });
    });

    this.shadowRoot.querySelectorAll(".cell[data-date]").forEach((cell, index) => {
      if (!cell.classList.contains("future")) {
        cell.classList.add("stagger");
        cell.style.animationDelay = `${Math.min(index * 8, 160)}ms`;
      }
      const pick = () => {
        this._selected = new Date(`${cell.dataset.date}T00:00:00`);
        this._render();
      };
      cell.addEventListener("click", pick);
      cell.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          pick();
        }
      });
    });
  }
}

class EnergyCalendarCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || { entities: [] };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    const entities = (this._config.entities || []).map((e) =>
      typeof e === "string" ? { entity: e } : e
    );
    const current = entities[0]?.entity;
    const candidates = this._hass
      ? Object.keys(this._hass.states).filter((id) => {
          const a = this._hass.states[id].attributes;
          return a.device_class === "energy" && a.state_class === "total_increasing";
        })
      : current
        ? [current]
        : [];

    this.shadowRoot.innerHTML = `
      <style>
        .row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
        label { font-size: 13px; color: var(--secondary-text-color); }
        select, input {
          padding: 8px; border-radius: 6px; border: 1px solid var(--divider-color);
          background: var(--card-background-color); color: var(--primary-text-color);
        }
        .hint { font-size: 11px; color: var(--secondary-text-color); }
      </style>
      <div class="row">
        <label>电量实体（累计型 energy）</label>
        <select id="entity">
          ${candidates
            .map(
              (id) =>
                `<option value="${id}" ${id === current ? "selected" : ""}>${id}</option>`
            )
            .join("")}
        </select>
        <div class="hint">仅列出 device_class=energy 且 state_class=total_increasing 的实体</div>
      </div>
      <div class="row">
        <label>电价（每 kWh，留空不显示电费）</label>
        <input id="price" type="number" step="0.01" value="${this._config.price ?? ""}">
      </div>
    `;

    this.shadowRoot.querySelector("#entity").addEventListener("change", (event) => {
      this._emit({ ...this._config, entities: [{ entity: event.target.value }] });
    });

    this.shadowRoot.querySelector("#price").addEventListener("change", (event) => {
      const next = { ...this._config };
      if (event.target.value === "") delete next.price;
      else next.price = Number(event.target.value);
      this._emit(next);
    });
  }

  _emit(config) {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      })
    );
  }
}

customElements.define("energy-calendar-card", EnergyCalendarCard);
customElements.define("energy-calendar-card-editor", EnergyCalendarCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "energy-calendar-card",
  name: "Energy Calendar",
  description: "按月日历显示每日用电量与电费（基于长期统计）",
  preview: true,
  documentationURL: "https://github.com/myml/ha-energy-calendar",
});

console.info(
  `%c ENERGY-CALENDAR-CARD %c ${CARD_VERSION} `,
  "color: white; background: #0fa47f; font-weight: 700;",
  "color: #0fa47f; background: white; font-weight: 700;"
);
