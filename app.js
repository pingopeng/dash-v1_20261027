"use strict";

const STORAGE_KEY = "marktueberblick.v1";
const NEWS_FEEDS = [
  { name: "tagesschau", url: "https://www.tagesschau.de/wirtschaft/index~rss2.xml" },
  { name: "Handelsblatt", url: "https://www.handelsblatt.com/contentexport/feed/schlagzeilen" }
];
const CORS_PROXY_URLS = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];
const REQUEST_TIMEOUT_MS = 6000;
const FX_CACHE = new Map();
const QUOTE_CACHE = new Map();
let portfolio = null;
let editingId = null;

const elements = {
  today: document.querySelector("#today-label"),
  status: document.querySelector("#app-status"),
  value: document.querySelector("#portfolio-value"),
  valueNote: document.querySelector("#portfolio-value-note"),
  gain: document.querySelector("#portfolio-gain"),
  gainNote: document.querySelector("#portfolio-gain-note"),
  count: document.querySelector("#position-count"),
  positions: document.querySelector("#positions-body"),
  emptyPortfolio: document.querySelector("#empty-portfolio"),
  news: document.querySelector("#news-list"),
  newsNote: document.querySelector("#news-note"),
  setupDialog: document.querySelector("#setup-dialog"),
  setupForm: document.querySelector("#setup-form"),
  setupRows: document.querySelector("#setup-positions"),
  setupError: document.querySelector("#setup-error"),
  currency: document.querySelector("#base-currency"),
  editDialog: document.querySelector("#edit-dialog"),
  editForm: document.querySelector("#edit-form"),
  editError: document.querySelector("#edit-error")
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function formatMoney(value, currency) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value) {
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2, signDisplay: "always" }).format(value)} %`;
}

function normalisePosition(position) {
  if (!position || typeof position !== "object") return null;
  const { id, name, symbol, shares, buyPrice } = position;
  if (
    typeof name !== "string" || !name.trim() ||
    typeof symbol !== "string" || !/^[A-Z0-9.^=_-]{1,20}$/.test(symbol) ||
    !Number.isFinite(shares) || shares <= 0 ||
    !Number.isFinite(buyPrice) || buyPrice <= 0
  ) return null;
  return {
    id: typeof id === "string" ? id : crypto.randomUUID(),
    name: name.trim().slice(0, 60),
    symbol,
    shares,
    buyPrice
  };
}

function readPortfolio() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return null;
    const data = JSON.parse(stored);
    if (!data || !Array.isArray(data.positions) || !["EUR", "USD", "GBP", "CHF"].includes(data.currency)) {
      throw new Error("Die gespeicherten Depotdaten haben ein ungültiges Format.");
    }
    const positions = data.positions.map(normalisePosition);
    if (positions.some((position) => position === null)) {
      throw new Error("Mindestens eine gespeicherte Position ist ungültig.");
    }
    return { currency: data.currency, positions };
  } catch (error) {
    throw new Error(`Deine gespeicherten Daten konnten nicht gelesen werden: ${error.message}`);
  }
}

function savePortfolio(nextPortfolio) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPortfolio));
    portfolio = nextPortfolio;
  } catch (error) {
    throw new Error(`Dein Depot konnte nicht lokal gespeichert werden: ${error.message}`);
  }
}

function createPositionRow(position = {}) {
  const row = document.createElement("div");
  row.className = "setup-position";
  row.innerHTML = `
    <label class="form-field"><span>Unternehmen</span><input name="name" maxlength="60" required placeholder="z. B. Apple"></label>
    <label class="form-field"><span>Börsenkürzel</span><input name="symbol" maxlength="20" required autocapitalize="characters" placeholder="AAPL"></label>
    <label class="form-field"><span>Stückzahl</span><input name="shares" type="number" min="0.000001" step="any" required inputmode="decimal" placeholder="10"></label>
    <label class="form-field"><span>Kaufkurs</span><input name="buyPrice" type="number" min="0.000001" step="any" required inputmode="decimal" placeholder="150,00"></label>
    <button class="remove-row" type="button" aria-label="Position entfernen" title="Position entfernen">×</button>`;
  const [name, symbol, shares, buyPrice] = row.querySelectorAll("input");
  name.value = position.name || "";
  symbol.value = position.symbol || "";
  shares.value = position.shares || "";
  buyPrice.value = position.buyPrice || "";
  symbol.addEventListener("input", () => { symbol.value = symbol.value.toUpperCase().replace(/\s/g, ""); });
  row.querySelector(".remove-row").addEventListener("click", () => {
    if (elements.setupRows.children.length === 1) {
      name.value = "";
      symbol.value = "";
      shares.value = "";
      buyPrice.value = "";
      name.focus();
    } else {
      row.remove();
    }
  });
  elements.setupRows.append(row);
}

function openSetupDialog(isFirstSetup) {
  elements.setupForm.reset();
  elements.setupRows.replaceChildren();
  elements.setupError.textContent = "";
  elements.currency.value = portfolio?.currency || "EUR";
  (portfolio?.positions.length ? portfolio.positions : [{}]).forEach(createPositionRow);
  document.querySelector("#cancel-setup").hidden = isFirstSetup;
  if (!elements.setupDialog.open) elements.setupDialog.showModal();
}

function openEditDialog(position = null) {
  editingId = position?.id || null;
  elements.editForm.reset();
  elements.editError.textContent = "";
  document.querySelector("#edit-title").textContent = position ? "Position bearbeiten." : "Position hinzufügen.";
  elements.editForm.elements.name.value = position?.name || "";
  elements.editForm.elements.symbol.value = position?.symbol || "";
  elements.editForm.elements.shares.value = position?.shares || "";
  elements.editForm.elements.buyPrice.value = position?.buyPrice || "";
  document.querySelectorAll(".currency-label").forEach((label) => { label.textContent = portfolio.currency; });
  elements.editDialog.showModal();
}

function getInputPosition(row) {
  const fields = Object.fromEntries([...row.querySelectorAll("input")].map((input) => [input.name, input.value.trim()]));
  const position = normalisePosition({
    id: crypto.randomUUID(),
    name: fields.name,
    symbol: fields.symbol.toUpperCase(),
    shares: Number(fields.shares),
    buyPrice: Number(fields.buyPrice)
  });
  if (!position) throw new Error("Bitte prüfe Name, Börsenkürzel, Stückzahl und Kaufkurs.");
  return position;
}

function requireHttps(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`Unsichere API-URL blockiert: ${parsed.origin}`);
  }
  return parsed.href;
}

async function fetchHttps(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const secureUrl = requireHttps(url);
  const response = await fetch(secureUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} von ${new URL(secureUrl).host}.`);
  return response;
}

async function fetchWithFallback(urls, parseResponse, label) {
  const errors = [];
  for (const url of urls) {
    try {
      const timeoutMs = new URL(url).hostname === "r.jina.ai" ? 15000 : REQUEST_TIMEOUT_MS;
      return await parseResponse(await fetchHttps(url, timeoutMs));
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${label} nicht erreichbar. ${errors.join(" | ")}`);
}

function proxyUrls(url) {
  return CORS_PROXY_URLS.map((proxy) => proxy(url));
}

async function parseYahooResponse(response, symbol) {
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  if (payload.chart?.error) {
    throw new Error(payload.chart.error.description || `Yahoo Finance lieferte keinen Kurs für ${symbol}.`);
  }
  let price = result?.meta?.regularMarketPrice;
  let currency = result?.meta?.currency;
  if (currency === "GBp" || currency === "GBX") {
    price /= 100;
    currency = "GBP";
  }
  if (!Number.isFinite(price) || typeof currency !== "string") {
    throw new Error(`Yahoo Finance lieferte keinen gültigen Kurs für ${symbol}.`);
  }
  return { price, currency };
}

async function fetchYahooQuote(symbol) {
  const cached = QUOTE_CACHE.get(symbol);
  if (cached && Date.now() - cached.time < 60_000) return cached.quote;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const quote = await fetchWithFallback(
    [url, ...proxyUrls(url)],
    (response) => parseYahooResponse(response, symbol),
    `Börsenkurs für ${symbol}`
  );
  QUOTE_CACHE.set(symbol, { quote, time: Date.now() });
  return quote;
}

async function fetchExchangeRate(from, to) {
  if (from === to) return 1;
  const key = `${from}:${to}`;
  const cached = FX_CACHE.get(key);
  if (cached && Date.now() - cached.time < 60 * 60 * 1000) return cached.rate;
  const primaryUrl = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
  const fallbackUrl = `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const rate = await fetchWithFallback(
    [primaryUrl, ...proxyUrls(primaryUrl), fallbackUrl, ...proxyUrls(fallbackUrl)],
    async (response) => {
      const data = await response.json();
      const value = data.rates?.[to];
      if (!Number.isFinite(value)) throw new Error(`Kein Wechselkurs von ${from} nach ${to} in der API-Antwort.`);
      return value;
    },
    `Wechselkurs ${from} → ${to}`
  );
  FX_CACHE.set(key, { rate, time: Date.now() });
  return rate;
}

async function getPositionValues(position) {
  const quote = await fetchYahooQuote(position.symbol);
  const rate = await fetchExchangeRate(quote.currency, portfolio.currency);
  const currentPrice = quote.price * rate;
  const marketValue = currentPrice * position.shares;
  const purchaseValue = position.buyPrice * position.shares;
  return {
    currentPrice,
    marketValue,
    gain: marketValue - purchaseValue,
    gainPercent: ((currentPrice - position.buyPrice) / position.buyPrice) * 100
  };
}

function renderPosition(position, values, errorMessage = "") {
  const row = document.createElement("tr");
  const companyCell = document.createElement("td");
  const company = document.createElement("div");
  company.className = "company-cell";
  const badge = document.createElement("span");
  badge.className = "ticker-badge";
  badge.textContent = position.symbol.slice(0, 3);
  const nameWrap = document.createElement("div");
  const name = document.createElement("div");
  name.className = "company-name";
  name.textContent = position.name;
  const symbol = document.createElement("div");
  symbol.className = "company-symbol";
  symbol.textContent = position.symbol;
  nameWrap.append(name, symbol);
  company.append(badge, nameWrap);
  companyCell.append(company);

  const sharesCell = document.createElement("td");
  sharesCell.textContent = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 4 }).format(position.shares);
  const buyCell = document.createElement("td");
  buyCell.textContent = formatMoney(position.buyPrice, portfolio.currency);
  const currentCell = document.createElement("td");
  currentCell.textContent = values ? formatMoney(values.currentPrice, portfolio.currency) : errorMessage || "Lädt …";
  const resultCell = document.createElement("td");
  resultCell.className = "result-cell";
  if (values) {
    resultCell.classList.add(values.gain > 0 ? "positive" : values.gain < 0 ? "negative" : "neutral");
    resultCell.textContent = formatMoney(values.gain, portfolio.currency);
    const percent = document.createElement("small");
    percent.textContent = formatPercent(values.gainPercent);
    resultCell.append(percent);
  } else {
    resultCell.classList.add(errorMessage ? "negative" : "neutral");
    resultCell.textContent = errorMessage ? "Nicht verfügbar" : "Lädt …";
  }

  const actionsCell = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "row-action";
  editButton.textContent = "✎";
  editButton.setAttribute("aria-label", `${position.name} bearbeiten`);
  editButton.addEventListener("click", () => openEditDialog(position));
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "row-action delete";
  deleteButton.textContent = "×";
  deleteButton.setAttribute("aria-label", `${position.name} entfernen`);
  deleteButton.addEventListener("click", () => removePosition(position.id));
  actions.append(editButton, deleteButton);
  actionsCell.append(actions);
  row.append(companyCell, sharesCell, buyCell, currentCell, resultCell, actionsCell);
  return row;
}

function renderPortfolio() {
  elements.positions.replaceChildren();
  elements.count.textContent = String(portfolio.positions.length);
  elements.emptyPortfolio.hidden = portfolio.positions.length > 0;
  if (!portfolio.positions.length) {
    elements.value.textContent = "–";
    elements.gain.textContent = "–";
    elements.valueNote.textContent = "Füge eine Position hinzu, um loszulegen.";
    elements.gainNote.textContent = "Seit deinem Kauf";
    return [];
  }
  const updates = portfolio.positions.map((position) => {
    const row = renderPosition(position, null);
    elements.positions.append(row);
    return refreshOnePosition(position, row);
  });
  elements.value.textContent = "Wird berechnet …";
  elements.gain.textContent = "Wird berechnet …";
  elements.value.className = "summary-value";
  elements.gain.className = "summary-value";
  return Promise.all(updates).then((errors) => errors.filter(Boolean));
}

async function refreshOnePosition(position, row) {
  try {
    const values = await getPositionValues(position);
    row.replaceWith(renderPosition(position, values));
    updateSummary();
    return null;
  } catch (error) {
    row.replaceWith(renderPosition(position, null, "Kurs nicht verfügbar"));
    updateSummary();
    return `${position.symbol}: ${error.message}`;
  }
}

async function updateSummary() {
  if (!portfolio.positions.length) return;
  const rows = [...elements.positions.querySelectorAll("tr")];
  const results = rows.map((row) => {
    const symbol = row.querySelector(".company-symbol")?.textContent;
    const position = portfolio.positions.find((item) => item.symbol === symbol);
    if (!position || row.querySelector(".result-cell")?.textContent.includes("Nicht verfügbar")) return null;
    const valueText = row.children[3]?.textContent;
    const gainText = row.querySelector(".result-cell")?.firstChild?.textContent;
    const currentPrice = parseFormattedMoney(valueText);
    return {
      marketValue: currentPrice === null ? null : currentPrice * position.shares,
      gain: parseFormattedMoney(gainText)
    };
  });
  if (results.some((result) => result === null || result.marketValue === null || result.gain === null)) {
    const failed = rows.filter((row) => row.querySelector(".result-cell")?.textContent.includes("Nicht verfügbar")).length;
    elements.value.textContent = failed ? "Teilweise verfügbar" : "Wird berechnet …";
    elements.valueNote.textContent = failed ? `${failed} Kurs(e) konnten nicht geladen werden.` : `Kurswerte in ${portfolio.currency}`;
    elements.gain.textContent = "–";
    elements.gainNote.textContent = "Kursdaten unvollständig";
    elements.gain.className = "summary-value neutral";
    return;
  }
  const totals = results.reduce((sum, item) => ({
    value: sum.value + item.marketValue,
    gain: sum.gain + item.gain
  }), { value: 0, gain: 0 });
  const invested = totals.value - totals.gain;
  const percent = invested ? (totals.gain / invested) * 100 : 0;
  elements.value.textContent = formatMoney(totals.value, portfolio.currency);
  elements.valueNote.textContent = `Kurse in ${portfolio.currency} · Umrechnung nach Bedarf`;
  elements.gain.textContent = formatMoney(totals.gain, portfolio.currency);
  elements.gain.className = `summary-value ${totals.gain > 0 ? "positive" : totals.gain < 0 ? "negative" : "neutral"}`;
  elements.gainNote.textContent = `${formatPercent(percent)} seit Kauf`;
}

function parseFormattedMoney(text) {
  if (!text || text.includes("Lädt") || text.includes("—")) return null;
  const digits = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

async function fetchFeed(feed) {
  const endpoint = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}`;
  const jinaEndpoint = `https://r.jina.ai/${feed.url}`;
  const items = await fetchWithFallback(
    [endpoint, jinaEndpoint, ...proxyUrls(feed.url)],
    async (response) => {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("json") || response.url.includes("rss2json.com")) {
        const data = await response.json();
        if (data.status !== "ok" || !Array.isArray(data.items)) {
          throw new Error(data.message || "RSS-Umwandler lieferte keine Nachrichten.");
        }
        return data.items.map((item) => ({
          source: feed.name,
          title: item.title,
          link: item.link,
          date: item.pubDate
        })).filter((item) => item.title && item.link).slice(0, 8);
      }

      const body = await response.text();
      if (response.url.includes("r.jina.ai")) {
        const lines = body.split(/\r?\n/);
        const headings = lines.map((line, index) => ({
          match: line.match(/^### \[(.+?)\]\((https:\/\/[^)]+)\)/),
          index
        })).filter((entry) => entry.match);
        return headings.map((entry, index) => {
          const nextHeading = headings[index + 1]?.index ?? lines.length;
          const date = lines.slice(entry.index + 1, nextHeading)
            .map((line) => line.trim())
            .find((line) => Number.isFinite(Date.parse(line)) && /\b\d{4}\b/.test(line)) || "";
          return {
            source: feed.name,
            title: entry.match[1],
            link: entry.match[2],
            date
          };
        }).slice(0, 8);
      }

      const xml = new DOMParser().parseFromString(body, "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("Der RSS-Feed enthält ungültiges XML.");
      return [...xml.querySelectorAll("item")].slice(0, 8).map((item) => ({
        source: feed.name,
        title: item.querySelector("title")?.textContent?.trim() || "",
        link: item.querySelector("link")?.textContent?.trim() || "",
        date: item.querySelector("pubDate")?.textContent || ""
      })).filter((item) => item.title && item.link);
    },
    `Nachrichten von ${feed.name}`
  );
  if (!items.length) throw new Error(`${feed.name} lieferte keine gültigen Schlagzeilen.`);
  return items;
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderNews(items, errors) {
  elements.news.replaceChildren();
  if (!items.length) {
    const message = document.createElement("p");
    message.className = "news-empty";
    message.textContent = "Nachrichten sind gerade nicht erreichbar. Bitte prüfe deine Verbindung oder lade die Seite erneut.";
    elements.news.append(message);
    elements.newsNote.textContent = errors.length
      ? `${errors.join(" ")} Prüfe die Internetverbindung oder versuche es später erneut.`
      : "Es wurden keine Nachrichten geliefert. Bitte versuche es später erneut.";
    return;
  }
  items.slice(0, 10).forEach((item) => {
    const link = safeLink(item.link);
    if (!link) return;
    const article = document.createElement("a");
    article.className = "news-item";
    article.href = link;
    article.target = "_blank";
    article.rel = "noopener noreferrer";
    const meta = document.createElement("div");
    meta.className = "news-meta";
    const source = document.createElement("span");
    source.className = "news-source";
    source.textContent = item.source;
    const date = document.createElement("span");
    const timestamp = Date.parse(item.date);
    date.textContent = Number.isFinite(timestamp)
      ? new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(timestamp)
      : "";
    meta.append(source, date);
    const title = document.createElement("p");
    title.className = "news-title";
    title.textContent = item.title;
    article.append(meta, title);
    elements.news.append(article);
  });
  elements.newsNote.textContent = errors.length
    ? `Einige Quellen sind nicht erreichbar: ${errors.join(" · ")}`
    : "Nachrichten stammen von den verlinkten Quellen.";
}

async function refreshNews() {
  const results = await Promise.allSettled(NEWS_FEEDS.map(fetchFeed));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason.message);
  const articles = results
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value)
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  renderNews(articles, errors);
  return errors;
}

function removePosition(id) {
  const position = portfolio.positions.find((item) => item.id === id);
  if (!position || !window.confirm(`${position.name} aus deinem Depot entfernen?`)) return;
  try {
    savePortfolio({ ...portfolio, positions: portfolio.positions.filter((item) => item.id !== id) });
    refreshAll();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function refreshAll() {
  setStatus("Kurse und Nachrichten werden aktualisiert …");
  const [newsErrors, quoteErrors] = await Promise.all([refreshNews(), renderPortfolio()]);
  const errors = [
    ...quoteErrors,
    ...newsErrors.map((error) => `Nachrichten: ${error}`)
  ];
  if (errors.length) {
    setStatus(`Einige Daten konnten nicht geladen werden: ${errors.join(" · ")}`, true);
    return;
  }
  setStatus(`Stand: ${new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
}

function initialise() {
  elements.today.textContent = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date()).toUpperCase();
  try {
    portfolio = readPortfolio();
    if (!portfolio) {
      portfolio = { currency: "EUR", positions: [] };
      openSetupDialog(true);
    }
  } catch (error) {
    setStatus(error.message, true);
    portfolio = { currency: "EUR", positions: [] };
    openSetupDialog(true);
  }
  refreshAll();
}

document.querySelector("#add-setup-row").addEventListener("click", () => createPositionRow());
document.querySelector("#cancel-setup").addEventListener("click", () => elements.setupDialog.close());
elements.setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  elements.setupError.textContent = "";
  try {
    const positions = [...elements.setupRows.querySelectorAll(".setup-position")].map(getInputPosition);
    if (!positions.length) throw new Error("Füge mindestens eine Position hinzu.");
    const seenSymbols = new Set();
    for (const position of positions) {
      if (seenSymbols.has(position.symbol)) throw new Error(`Das Kürzel ${position.symbol} ist doppelt eingetragen.`);
      seenSymbols.add(position.symbol);
    }
    savePortfolio({ currency: elements.currency.value, positions });
    elements.setupDialog.close();
    refreshAll();
  } catch (error) {
    elements.setupError.textContent = error.message;
  }
});

document.querySelector("#settings-button").addEventListener("click", () => openEditDialog());
document.querySelector("#add-position-button").addEventListener("click", () => openEditDialog());
document.querySelector("#empty-add-button").addEventListener("click", () => openEditDialog());
document.querySelector("#cancel-edit").addEventListener("click", () => elements.editDialog.close());
elements.editForm.elements.symbol.addEventListener("input", (event) => {
  event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/\s/g, "");
});
elements.editForm.addEventListener("submit", (event) => {
  event.preventDefault();
  elements.editError.textContent = "";
  try {
    const fields = new FormData(elements.editForm);
    const position = normalisePosition({
      id: editingId || crypto.randomUUID(),
      name: String(fields.get("name")).trim(),
      symbol: String(fields.get("symbol")).trim().toUpperCase(),
      shares: Number(fields.get("shares")),
      buyPrice: Number(fields.get("buyPrice"))
    });
    if (!position) throw new Error("Bitte prüfe alle Angaben und verwende ein gültiges Börsenkürzel.");
    const duplicate = portfolio.positions.some((item) => item.symbol === position.symbol && item.id !== editingId);
    if (duplicate) throw new Error(`Das Kürzel ${position.symbol} ist bereits im Depot.`);
    const positions = editingId
      ? portfolio.positions.map((item) => item.id === editingId ? position : item)
      : [...portfolio.positions, position];
    savePortfolio({ ...portfolio, positions });
    elements.editDialog.close();
    refreshAll();
  } catch (error) {
    elements.editError.textContent = error.message;
  }
});
document.querySelector("#refresh-button").addEventListener("click", refreshAll);

initialise();
