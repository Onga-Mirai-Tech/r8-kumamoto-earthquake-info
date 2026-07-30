// scripts/fetch-news.mjs
// GitHub Actions上（サーバー側）でRSSを取得し、data/news.json に書き出す。
// ブラウザ側のCORS制約を受けないため、rss2json等の外部プロキシは不要。

import Parser from 'rss-parser';
import { writeFile, readFile, mkdir } from 'fs/promises';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KumamotoNewsBot/1.0)' },
});

const OUTPUT_PATH = 'data/news.json';

// 複数クエリに分割した方がGoogle News側のパース失敗リスクが下がる
const FEEDS = [
  {
    url: 'https://news.google.com/rss/search?q=%E7%86%8A%E6%9C%AC%E5%9C%B0%E9%9C%87&hl=ja&gl=JP&ceid=JP:ja',
    label: 'general',
  },
  {
    url: 'https://news.google.com/rss/search?q=%E7%86%8A%E6%9C%AC%E6%97%A5%E6%97%A5%E6%96%B0%E8%81%9E+%E5%9C%B0%E9%9C%87&hl=ja&gl=JP&ceid=JP:ja',
    label: 'kumanichi',
  },
  {
    url: 'https://news.google.com/rss/search?q=RKK+OR+TKU+OR+KKT+%E7%86%8A%E6%9C%AC+%E5%9C%B0%E9%9C%87&hl=ja&gl=JP&ceid=JP:ja',
    label: 'local-tv',
  },
];

const disasterKeywords = /熊本|地震|震度|余震|津波|避難|被災|倒壊|崩落|停電|断水|災害|救助|支援|物資|通行止|運休|火災|土砂崩れ|気象庁|注意報|警報|防災|県庁|市役所/;
const excludeKeywords = /野球|サッカー|五輪|オリンピック|ゴルフ|テニス|芸能|アイドル|映画|ドラマ|アニメ|将棋|ロアッソ|ヴォルターズ/;

function isDisasterRelated(text) {
  if (excludeKeywords.test(text)) return false;
  return disasterKeywords.test(text);
}

function detectCategory(text) {
  if (/停電|断水|通行止|運休|交通|道路|鉄道|新幹線|ガス|通信障害|インフラ|復旧/.test(text)) return 'infra';
  if (/避難|給水|支援|物資|ボランティア|炊き出し|仮設住宅|生活|救助法|相談/.test(text)) return 'life';
  if (/震度|地震|津波|余震|倒壊|崩落|死者|負傷|火災|土砂崩れ|被害|警戒/.test(text)) return 'disaster';
  return 'other';
}

function extractMediaName(titleText) {
  if (titleText.includes('熊本日日新聞') || titleText.includes('熊日')) return '熊本日日新聞';
  if (titleText.includes('RKK') || titleText.includes('熊本放送')) return 'RKK熊本放送';
  if (titleText.includes('TKU') || titleText.includes('テレビ熊本')) return 'TKUテレビ熊本';
  if (titleText.includes('KKT') || titleText.includes('熊本県民テレビ')) return 'KKT熊本県民テレビ';
  if (titleText.includes('NHK')) return 'NHK';
  return '地元メディア';
}

function stripAndTrim(html, max = 80) {
  if (!html) return '';
  const text = html.replace(/<[^>]*>/g, '').trim();
  return text.length > max ? text.slice(0, max) + '...' : text;
}

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return parsed.items.map((item) => {
      let title = (item.title || '').replace(/\s-\s[^-]+$/, '');
      const desc = stripAndTrim(item.contentSnippet || item.content || '');
      const text = title + ' ' + desc;
      if (!isDisasterRelated(text)) return null;
      return {
        title,
        link: item.link,
        pubDate: item.isoDate || item.pubDate,
        sourceName: extractMediaName(item.title || ''),
        type: 'local',
        description: desc,
        category: detectCategory(text),
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn(`[warn] Failed to fetch feed "${feed.label}":`, err.message);
    return null; // 取得失敗を明示（空配列と区別する）
  }
}

async function loadPrevious() {
  try {
    const raw = await readFile(OUTPUT_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { items: [], lastSuccess: null };
  }
}

async function main() {
  await mkdir('data', { recursive: true });
  const previous = await loadPrevious();

  const results = await Promise.all(FEEDS.map(fetchFeed));
  const anySucceeded = results.some((r) => r !== null);
  const newItems = results.filter(Boolean).flat();

  // 全フィードが失敗した場合は前回データを維持し、記事を消さない
  const itemPool = anySucceeded
    ? [...newItems, ...previous.items]
    : previous.items;

  const seen = new Set();
  const deduped = itemPool
    .filter((item) => {
      if (seen.has(item.title)) return false;
      seen.add(item.title);
      return true;
    })
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 100); // 直近100件まで保持

  const output = {
    items: deduped,
    lastSuccess: anySucceeded ? new Date().toISOString() : previous.lastSuccess,
    lastAttempt: new Date().toISOString(),
    fetchOk: anySucceeded,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Wrote ${deduped.length} items to ${OUTPUT_PATH} (fetchOk=${anySucceeded})`);
}

main().catch((err) => {
  console.error('Fatal error in fetch-news.mjs:', err);
  process.exit(1);
});
