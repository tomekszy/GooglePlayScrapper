import fs from 'fs/promises';
import { chromium } from 'playwright';
import { createObjectCsvWriter } from 'csv-writer';
import he from 'he';

type Result = {
    package: string;
    appName: string;
    hasWear: 'yes' | 'no' | 'unknown';
    reason: string;
    playUrl: string;
};

const PACKAGES_FILE = 'packages.txt';
const OUT_CSV = 'wear-check-results.csv';
const CONCURRENCY = 4;
const NAV_TIMEOUT = 45000;

async function readPackages(filePath: string): Promise<string[]> {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => l.replace(/^package:/, ''));
}

function makePlayUrl(pkg: string) {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=pl&gl=US`;
}

async function analyzeForWatchSection(pageHtml: string): Promise<{
    hasWear: 'yes' | 'no' | 'unknown';
    reason: string;
    appName: string
}> {
    const lowered = pageHtml.toLowerCase();

    // Extract app name more robustly: search for the main title element(s) on Play pages
    let appName = '';
    const matchH1 = pageHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (matchH1) appName = he.decode(matchH1[1].replace(/<[^>]+>/g, '').trim());

    // Heuristic: Play store shows rating breakdown per device in a section that lists devices
    // We'll look for device tabs/labels like 'Phone', 'Tablet', 'Wear OS', 'Watch', 'Zegarek', 'Smartwatch'
    const watchKeywords = ['watch', 'wear os', 'wearos', 'zegarek', 'smartwatch', 'dla zegarka'];

    // But instead of matching anywhere, try to detect device-specific review/ratings labels
    const deviceSectionPatterns = [
        /Rate this app for your (phone|tablet|watch|wear os)/i,
        /ocena dla (telefonu|tabletu|zegarka)/i,
        /reviews for (phone|tablet|watch)/i,
        /oceny dla:.*zegarek/i,
        /select a device.*watch/i,
        /device reviews/i,
    ];

    for (const p of deviceSectionPatterns) {
        if (p.test(pageHtml)) {
            // ensure it specifically contains a watch-related token nearby
            for (const kw of watchKeywords) {
                if (pageHtml.toLowerCase().includes(kw)) {
                    return {hasWear: 'yes', reason: `found device-rating section mentioning "${kw}"`, appName};
                }
            }
        }
    }

    // Alternative: look for device tabs / aria-labels that include watch
    const ariaWatch = /aria-label=["'][^"']*(watch|zegarek|wear os|smartwatch)[^"']*["']/i;
    if (ariaWatch.test(pageHtml)) {
        return {hasWear: 'yes', reason: 'found aria-label/tab for watch', appName};
    }

    // Another heuristic: Play store sometimes shows separate rating counts with device names
    const deviceListRegex = /(phone|tablet|watch|wear os|zegarek|smartwatch)/i;
    if (deviceListRegex.test(lowered) && /rating|reviews|ocen/i.test(lowered)) {
        // But ensure 'watch' appears near 'rating' keyword
        const idxWatch = lowered.search(/watch|zegarek|wear os|smartwatch/);
        const idxRating = lowered.search(/rating|ratings|reviews|ocen|opinie/);
        if (idxWatch >= 0 && Math.abs(idxWatch - idxRating) < 600) {
            return {hasWear: 'yes', reason: 'found watch token close to rating/reviews', appName};
        }
    }

    // If the page explicitly lists supported devices and watch not present -> treat as no
    // Check for "Available on" or "Available on" lists that don't include watch tokens
    const availableOnSection = /available on[:\s\S]{0,200}/i;
    if (availableOnSection.test(pageHtml)) {
        if (!watchKeywords.some(kw => lowered.includes(kw))) {
            return {hasWear: 'no', reason: 'available-on section without watch mention', appName};
        }
    }

    // Fallback: unknown
    return {hasWear: 'no', reason: 'no watch-specific rating section found', appName};
}

async function worker(browser: any, pkgs: string[], results: Result[]) {
    const context = await browser.newContext({userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'});
    const page = await context.newPage();
    for (const pkg of pkgs) {
        const url = makePlayUrl(pkg);
        try {
            await page.goto(url, {waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT});
            // wait a bit for dynamic parts to appear (increase for slow pages)
            await page.waitForTimeout(2000);
            const html = await page.content();
            const analysis = await analyzeForWatchSection(html);
            results.push({
                package: pkg,
                appName: analysis.appName || '',
                hasWear: analysis.hasWear,
                reason: analysis.reason,
                playUrl: url,
            });
            console.log(pkg, analysis.hasWear, analysis.reason);
        } catch (err: any) {
            results.push({
                package: pkg,
                appName: '',
                hasWear: 'unknown',
                reason: `error: ${err.message}`,
                playUrl: url,
            });
            console.error('Error for', pkg, err.message);
        }
    }
    await page.close();
    await context.close();
}

async function main() {
    const pkgs = await readPackages(PACKAGES_FILE);
    const browser = await chromium.launch({headless: true});
    const results: Result[] = [];

    // simple concurrency pool
    const chunkSize = Math.max(1, Math.ceil(pkgs.length / CONCURRENCY));
    const chunks: string[][] = [];
    for (let i = 0; i < pkgs.length; i += chunkSize) chunks.push(pkgs.slice(i, i + chunkSize));

    await Promise.all(chunks.map(chunk => worker(browser, chunk, results)));

    await browser.close();

    const csvWriter = createObjectCsvWriter({
        path: OUT_CSV,
        header: [
            {id: 'package', title: 'package'},
            {id: 'appName', title: 'app_name'},
            {id: 'hasWear', title: 'has_wear'},
            {id: 'reason', title: 'reason'},
            {id: 'playUrl', title: 'play_url'},
        ],
        fieldDelimiter: ';',
        alwaysQuote: true,
    });

    await csvWriter.writeRecords(results);
    console.log('Done. Results saved to', OUT_CSV);
}

main().catch(err => {
    console.error('Fatal', err);
    process.exit(1);
});
