import fs from 'fs/promises';
import { chromium } from 'playwright';
import { createObjectCsvWriter } from 'csv-writer';

type Result = {
    package: string;
    appName: string;
    hasWear: 'yes' | 'no' | 'unknown';
    reason: string;
    playUrl: string;
};

const PACKAGES_FILE = 'packages.txt';
const OUT_CSV = 'wear-check-results.csv';

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

async function analyzePageContent(html: string): Promise<{
    hasWear: 'yes' | 'no' | 'unknown';
    reason: string;
    appName: string
}> {
    const lowered = html.toLowerCase();
    const appNameMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const appName = appNameMatch ? appNameMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    // keywords and heuristics
    const wearKeywords = ['wear os', 'android wear', 'androidwear', 'watch'];
    for (const kw of wearKeywords) {
        if (lowered.includes(kw)) {
            return {hasWear: 'yes', reason: `found keyword "${kw}"`, appName};
        }
    }
    // check for badges/labels typical on Play (heuristic selectors text)
    if (lowered.includes('available on watch') || lowered.includes('for wear os')) {
        return {hasWear: 'yes', reason: 'found explicit availability text', appName};
    }
    // if page looks like a generic listing but no wear hints
    if (lowered.includes('this app is incompatible with your device') && lowered.includes('watch')) {
        return {hasWear: 'no', reason: 'incompatible / no wear mention', appName};
    }
    return {hasWear: 'unknown', reason: 'no clear wear markers', appName};
}

async function main() {
    const pkgs = await readPackages(PACKAGES_FILE);
    const browser = await chromium.launch({headless: true});
    const context = await browser.newContext({userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'});
    const page = await context.newPage();
    const results: Result[] = [];

    for (const pkg of pkgs) {
        const url = makePlayUrl(pkg);
        try {
            await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
            // wait a bit for JS-rendered content
            await page.waitForTimeout(1500);
            const html = await page.content();
            const analysis = await analyzePageContent(html);
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
    });

    await csvWriter.writeRecords(results);
    console.log('Done. Results saved to', OUT_CSV);
}

main().catch(err => {
    console.error('Fatal', err);
    process.exit(1);
});
