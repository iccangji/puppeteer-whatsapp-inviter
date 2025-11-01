import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createLogger } from "./utils/logger.js";
import path from "path";
import fs from "fs";

puppeteerExtra.use(StealthPlugin());

export function createProfile(workerId) {
    const profileDir = path.join("/data", 'profiles', `worker${workerId}`);
    if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir);
        return true;
    } else {
        return false;
    }
}

function useProfile(workerId) {
    const profileDir = path.join("/data", 'profiles', `worker${workerId}`);
    if (!fs.existsSync(profileDir)) {
        return null;
    }
    return profileDir;
}

async function launchBrowser(profile) {
    const browser = await puppeteerExtra.launch({
        headless: "new",
        executablePath: "/usr/bin/google-chrome-stable",
        args: [
            `--user-data-dir=${profile}`,
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--window-size=1366,768",
            "--start-maximized",
        ],
    });
    return browser
}

// BOT
export async function puppeteerBot(workerId, data) {
    const logger = createLogger(workerId);
    logger.info("ℹ️ Menjalankan browser...");
    const profile = useProfile(workerId);
    logger.info(`ℹ️ Use Profile: ${profile}`)
    if (!profile) {
        logger.info(profile);

        logger.error("❌ Profile not found. Worker OFF");
        return { success: false, message: "Profile not found" };
    }

    const browser = await launchBrowser(profile);
    const page = await browser.newPage();
    try {
        // WhatsApp Web
        logger.info("ℹ️ Membuka web WhatsApp...");
        await page.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 30 * 1000));

        // logger.info("⏳ Tunggu 3 menit loading chat...");
        // await new Promise(r => setTimeout(r, 3 * 60 * 1000));

        // Cek login
        const qrCanvas = await page.$('canvas[aria-label="Scan this QR code to link a device!"]');
        if (qrCanvas) {
            logger.error("❌ WA Suspended / Logged Out. Worker OFF");
            await browser.close();
            return { success: false, message: "WA Suspend / Log Out" };
        }

        // Cari grup
        const groupSelector = `span[title="${data.group}"]`;
        const groupElement = await page.$(groupSelector);

        if (!groupElement) {
            logger.error(`❌ Group ${data.group} not found`);
            await browser.close();
            return { success: true, message: `Group not found` };
        }

        // Klik grup
        await groupElement.click();
        logger.info(`✅ Berhasil klik grup "${data.group}"`);
        await new Promise(r => setTimeout(r, 3 * 1000));

        // Klik tombol Group Info
        const groupInfoSelector = 'div[title="Profile details"][role="button"]';
        const groupInfoButton = await page.$(groupInfoSelector);

        if (!groupInfoButton) {
            logger.error("❌ Tombol Group Info tidak ditemukan.");
            await browser.close();
            return { success: false, message: `Group ${data.group} info button not found` };
        }

        await groupInfoButton.click();
        logger.info("✅ Berhasil klik Group Info");

        // Klik tombol Add Member
        const addMemberClick = await page.evaluate(() => {
            const xpath = "//div[text()='Add member']";
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const el = result.singleNodeValue;
            if (el) {
                el.click();
                return true;
            } else {
                return false;
            }
        });
        if (addMemberClick) {
            logger.info("✅ Berhasil klik Add Member");
        } else {
            logger.error("❌ Add Member button not found");
            await browser.close();
            return { success: true, message: "Group Banned" };
        }

        // Tunggu dialog add member terbuka
        await new Promise(r => setTimeout(r, 3 * 1000));

        // Pilih input "Search name or number"
        const searchInputSelector = 'div[aria-label="Search name or number"][contenteditable="true"]';
        const searchInput = await page.$(searchInputSelector);

        if (!searchInput) {
            logger.error("❌ Input Search Name/Number tidak ditemukan.");
            await browser.close();
            return { success: false, message: "Input Search Name/Number not found" };
        }

        // Klik untuk fokus
        await searchInput.click({ clickCount: 2 });

        // Ketik nama kontak
        const contactName = data.member;
        await page.type(searchInputSelector, contactName, { delay: 100 });

        logger.info(`✅ Mengetik nama kontak: ${contactName}`);

        // Tunggu nomor handphone ditemukan
        await new Promise(r => setTimeout(r, 5 * 1000));

        // Klik checkbox pada hasil pencarian kontak
        const checkboxes = await page.$$('div[role="checkbox"][aria-checked="false"]');

        if (checkboxes.length === 0) {
            logger.error("❌ Tidak ada kontak ditemukan.");
            await browser.close();
            return { success: true, message: 'Contact Not Found' };
        }

        // Klik elemen
        await checkboxes[0].click();
        logger.info("✅ Berhasil klik checkbox kontak");
        await new Promise(r => setTimeout(r, 3 * 1000));


        // Klik tombol Confirm (ikon centang)
        const confirmButtonSelector = 'span[aria-label="Confirm"]';
        const confirmButton = await page.$(confirmButtonSelector);

        if (!confirmButton) {
            logger.error("❌ Tombol Confirm tidak ditemukan.");
            await browser.close();
            return { success: false, message: "Confirm button not found" };
        }

        await confirmButton.click();
        logger.info("✅ Berhasil klik tombol Confirm");

        // Klik tombol "Add member" dalam modal konfirmasi
        await page.waitForSelector('body');

        const addMemberClicked = await page.evaluate(() => {
            const xpath = "//span[text()='Add member']";
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const el = result.singleNodeValue;
            if (el) {
                el.click();
                return true;
            }
            return false;
        });

        if (!addMemberClicked) {
            logger.error("❌ Tombol 'Add member' di modal tidak ditemukan.");
            await browser.close();
            return { success: false, message: "Add member in modal not found" };
        }

        logger.info("✅ Berhasil klik tombol 'Add member' dalam modal konfirmasi");

        // Tunggu kemungkinan munculnya pesan error "Couldn't add"
        const privatedMessageFound = await page.waitForFunction(
            () => !!document.evaluate("//div[contains(text(), \"Couldn't add\")]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue,
            { timeout: 5000 }
        ).catch(() => null);

        if (privatedMessageFound) {
            const errorText = await page.evaluate(() => {
                const result = document.evaluate("//div[contains(text(), \"Couldn't add\")]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const el = result.singleNodeValue;
                return el ? el.textContent : null;
            });

            if (errorText) {
                logger.warn(`⚠️ Tidak bisa menambahkan nomor`);

                // Klik tombol Cancel agar dialog tertutup
                const cancelClicked = await page.evaluate(() => {
                    const result = document.evaluate("//span[text()='Cancel']", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const el = result.singleNodeValue;
                    if (el) {
                        el.click();
                        return true;
                    }
                    return false;
                });

                if (cancelClicked) {
                    logger.info("🟡 Dialog ditutup (Cancel ditekan).");
                }

                await browser.close();
                return { success: true, message: "Private" };
            }
        }
        await browser.close();
        return { success: true, message: "Success" };
    } catch (err) {
        await browser.close();
        logger.error("❌ Error bot:", err);
        return { success: false, message: err };
    }
}

// SERVER
const workers = new Map();
export async function launchWorker(workerId) {
    const logger = createLogger(workerId);
    const profile = useProfile(workerId);
    if (!profile) {
        return null;
    }
    if (workers.has(workerId)) return workers.get(workerId);

    logger.info(`🚀 Launching browser for worker ${workerId}...`);
    const browser = await launchBrowser(profile);
    const page = await browser.newPage();
    await page.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 30 * 1000));

    const worker = { browser, page, qrBase64: null, lastUpdate: 0 };
    workers.set(workerId, worker);

    refreshQrLoop(workerId);
    return worker;
}

async function refreshQrLoop(workerId) {
    const logger = createLogger(workerId);
    const worker = workers.get(workerId);
    if (!worker) return;

    const { page } = worker;
    try {
        const qrCanvas = await page.$('canvas[aria-label="Scan this QR code to link a device!"]');
        if (qrCanvas) {
            const qrBase64 = await page.screenshot({ fullPage: true, encoding: "base64" });
            worker.qrBase64 = qrBase64;
            worker.lastUpdate = Date.now();
        } else {
            worker.qrBase64 = null;
        }
    } catch (e) {
        logger.error(`QR refresh error [${workerId}]:`, e.message);
    }

    setTimeout(() => refreshQrLoop(workerId), 15 * 1000);
}

export async function closeWorker(workerId) {
    const logger = createLogger(workerId);
    const worker = workers.get(workerId);
    try {
        const browser = worker.browser;
        const pages = await browser.pages();
        for (const page of pages) {
            try { await page.close({ runBeforeUnload: true }); } catch { }
        }

        await browser.close();

        await new Promise((r) => setTimeout(r, 1500));

        const profilePath = `/data/profiles/worker${workerId}`;
        const locks = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
        for (const file of locks) {
            const p = `${profilePath}/${file}`;
            if (fs.existsSync(p)) fs.rmSync(p, { force: true });
        }

        logger.info(`✅ Worker ${workerId} cleaned`);

    } catch (err) { } finally {
        workers.delete(workerId);
    }
    return true;
}

export function getWorker(workerId) {
    return workers.get(workerId);
}

export function getAllWorkers() {
    return Array.from(workers.keys());
}

export function cleanAllWorkers() {
    const logger = createLogger('-main');
    const profilePath = `/data/profiles/*`;
    const locks = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
    for (const file of locks) {
        const p = `${profilePath}/${file}`;
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }

    logger.info(`✅ All worker cleaned`);
    return true;
}