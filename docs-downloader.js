// --- START OF FILE docs-downloader.js ---

const { chromium } = require('playwright');
const fs = require('fs/promises');
const https = require('https');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Configuration
const MAX_RETRIES = 1;

// Function to perform action with retries
async function withRetry(actionFn, actionName, retryCount = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`Retry attempt ${attempt}/${retryCount} for ${actionName}...`);
      }
      return await actionFn();
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt + 1}/${retryCount + 1} failed for ${actionName}: ${error.message}`);
      if (attempt < retryCount) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error(`All ${retryCount + 1} attempts failed for ${actionName}: ${lastError.message}`);
}

// Function to download PDF file
async function downloadPdf(url, title) {
  console.log(`Downloading PDF: ${title}... (URL: ${url})`);
  const sanitizedTitle = title.replace(/[\/\\\:\*\?\"\<\>\|]/g, '_');
  const filePath = path.join('downloads', `${sanitizedTitle}.pdf`);

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download PDF. Status code: ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          if (buffer.length === 0) {
            reject(new Error(`Downloaded PDF for ${title} is empty.`));
            return;
          }
          try {
            await fs.mkdir('downloads', { recursive: true });
          } catch (err) {
            if (err.code !== 'EEXIST') throw err;
          }
          await fs.writeFile(filePath, buffer);
          console.log(`Successfully downloaded: ${filePath}`);
          resolve(filePath);
        } catch (error) {
          reject(new Error(`Error writing PDF file for ${title}: ${error.message}`));
        }
      });
      res.on('error', (err) => reject(new Error(`HTTPS request error for PDF ${title}: ${err.message}`)));
    }).on('error', (err) => reject(new Error(`HTTPS error for PDF ${title}: ${err.message}`)));
  });
}

// Main scraping function
async function scrapeAndDownloadDocs(targetUrl, productName, productVersion, runHeadless) {
  let browser = null;
  let context = null;

  console.log(`Starting scraper for: ${targetUrl}`);
  console.log(`Running in ${runHeadless ? 'headless' : 'headed (visible browser)'} mode.`);
  console.log(`PDF extraction method: ${runHeadless ? 'Direct Regex from HTML' : 'UI Dropdown Interaction'}`);


  const launchOptions = { headless: runHeadless };
  if (!runHeadless) {
    launchOptions.slowMo = 1000;
    console.log("Headed mode: slowMo enabled (1000ms).");
  }

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';

  try {
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext({ userAgent });

    await context.addCookies([
      { name: 'notice_behavior', value: 'expressed,eu', domain: '.redhat.com', path: '/' },
      { name: 'notice_preferences', value: '2:', domain: '.redhat.com', path: '/' },
      { name: 'notice_gdpr_prefs', value: '0,1,2:', domain: '.redhat.com', path: '/' }
    ]);

    const mainProductPage = await context.newPage();
    console.log('Navigating to main product listing page...');
    await withRetry(
      async () => await mainProductPage.goto(targetUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }),
      `navigation to main documentation page for ${productName} ${productVersion}`
    );

    console.log('Waiting for book tiles to load...');
    await withRetry(
      async () => await mainProductPage.waitForSelector('rh-tile', { timeout: 30000, state: 'visible' }),
      'waiting for documentation tiles to load'
    );

    const books = await mainProductPage.evaluate(() => {
      const tiles = document.querySelectorAll('rh-tile');
      return Array.from(tiles).map(tile => {
        const linkElement = tile.querySelector('h3 a');
        return {
          title: linkElement ? linkElement.textContent.trim() : '',
          url: linkElement ? linkElement.href : '',
        };
      });
    });
    await mainProductPage.close();

    const downloadResults = [];
    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      console.log(`\n========================================`);
      console.log(`Processing book ${i+1}/${books.length}: ${book.title}`);
      console.log(`Book HTML Page URL: ${book.url}`);

      let bookPage = null;
      let pdfUrl = null;
      let newPageForPdf = null; // Only used in headed mode

      try {
        bookPage = await context.newPage();
        console.log(`Navigating to book HTML page: ${book.title}`);
        await withRetry(
          async () => await bookPage.goto(book.url, { timeout: 45000, waitUntil: 'domcontentloaded' }),
          `navigation to ${book.title} HTML page`
        );

        if (runHeadless) {
          // --- HEADLESS MODE: Direct Regex Extraction ---
          console.log(`Attempting to extract PDF link directly from HTML (headless mode) for ${book.title}...`);
          const pageContent = await bookPage.content();
          const escapedProductName = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const escapedProductVersion = productVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pdfLinkRegex = new RegExp(
            `(https://docs\\.redhat\\.com/en/documentation/${escapedProductName}/${escapedProductVersion}/pdf/[^"]+\\.pdf)`, "i"
          );
          const match = pageContent.match(pdfLinkRegex);
          if (match && match[1]) {
            pdfUrl = match[1];
            console.log(`Found PDF URL via regex: ${pdfUrl}`);
          } else {
            console.warn(`Could not find PDF link via regex for ${book.title}.`);
            throw new Error(`Regex failed to find specific PDF link for ${book.title}.`);
          }
        } else {
          // --- HEADED MODE: UI Dropdown Interaction ---
          console.log(`Waiting for format dropdown on ${book.title} page (headed mode)...`);
          await withRetry(
            async () => await bookPage.waitForSelector('#page-format', { timeout: 15000, state: 'visible' }),
            `waiting for format dropdown on ${book.title} page`
          );

          let newPagePromise;
          try {
            console.log(`Setting up listener for new page/tab creation for ${book.title}...`);
            newPagePromise = context.waitForEvent('page', { timeout: 60000 });

            console.log(`Selecting PDF option for ${book.title}...`);
            await withRetry(
              async () => await bookPage.selectOption('#page-format', 'pdf'),
              `selecting PDF format for ${book.title}`
            );

            console.log(`Waiting for PDF page/tab to be created for ${book.title}...`);
            newPageForPdf = await newPagePromise;

            console.log(`New page/tab object CREATED for ${book.title}. Initial reported URL: ${newPageForPdf.url()}`);
            // Add debug listeners if needed again
            newPageForPdf.on('close', () => console.log(`DEBUG (Headed - PDF Page for ${book.title}): 'close' event. Last URL: ${newPageForPdf?.url()}`));


            console.log(`Waiting for the new page/tab for ${book.title} to navigate to a PDF URL...`);
            await withRetry(async () => {
                await newPageForPdf.waitForURL(/.*\.pdf(\?.*)?$/i, { timeout: 60000 });
                console.log(`New page/tab for ${book.title} successfully navigated to PDF URL: ${newPageForPdf.url()}`);
            }, `waiting for new page to reach PDF URL for ${book.title}`);

            pdfUrl = newPageForPdf.url();

            console.log(`Confirmed PDF URL for ${book.title}: ${pdfUrl}. Waiting for content to load...`);
            await withRetry(
                async () => {
                    await newPageForPdf.waitForLoadState('load', { timeout: 90000 });
                },
                `waiting for PDF content 'load' state for ${book.title}`
            );
            console.log(`PDF content loaded for ${book.title} at ${newPageForPdf.url()}`);

          } catch (uiPdfError) {
            console.error(`Error during UI PDF interaction for ${book.title}: ${uiPdfError.message}`);
            throw uiPdfError; // Propagate to main catch for this book
          }
        } // End of headless/headed conditional block

        // --- Common Download Logic ---
        if (!pdfUrl) {
            throw new Error(`No PDF URL could be determined for ${book.title}.`);
        }

        let downloadPath = null;
        const downloadTitle = `${productName}-${productVersion}-${book.title}`;
        downloadPath = await withRetry(
          async () => await downloadPdf(pdfUrl, downloadTitle),
          `downloading PDF for ${book.title}`
        );
        downloadResults.push({ ...book, pdfUrl, downloadPath, success: true });

      } catch (error) { // Main catch for processing a single book
        console.error(`Error processing ${book.title}:`, error.message);
        const criticalErrorPatterns = ['Object with guid', 'not bound in the connection', 'has been closed', 'Target closed', 'Navigation failed', 'context has been destroyed'];
        const isCriticalError = criticalErrorPatterns.some(pattern => error.message.includes(pattern));
        if (isCriticalError && browser) {
          console.error('CRITICAL ERROR DETECTED. Scheduling browser restart for next iteration...');
          try {
            if (bookPage && !bookPage.isClosed()) await bookPage.close().catch(e => console.warn('Failed to close bookPage during critical error handling:', e.message));
            if (newPageForPdf && !newPageForPdf.isClosed()) await newPageForPdf.close().catch(e => console.warn('Failed to close newPageForPdf during critical error handling:', e.message));
            if (context) await context.close().catch(e => console.warn('Failed to close context during critical error handling:', e.message));
            if (browser) await browser.close().catch(e => console.warn('Failed to close browser during critical error handling:', e.message));
          } catch (closeError) {
            console.warn('Error during browser cleanup on critical error:', closeError.message);
          }
          browser = null; context = null;
        }
        downloadResults.push({ ...book, pdfUrl: null, downloadPath: null, success: false, error: error.message, criticalError: isCriticalError });
      } finally {
        if (bookPage && !bookPage.isClosed()) {
          await bookPage.close().catch(e => console.warn(`Could not close bookPage for ${book.title} in finally: ${e.message}`));
        }
        if (newPageForPdf && !newPageForPdf.isClosed()) { // Close PDF page if it was opened (headed mode)
          await newPageForPdf.close().catch(e => console.warn(`Could not close newPageForPdf for ${book.title} in finally: ${e.message}`));
        }
      }

      if (!runHeadless) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Keep a small delay for headed
      }
    } // End of for loop over books

    // ... (results saving and summary logic as before) ...
    const resultsFilename = `${productName.replace(/[^a-z0-9]/gi, '_')}-${productVersion.replace(/[^a-z0-9.]/gi, '_')}-download-results.json`;
    try {
      await fs.writeFile(resultsFilename, JSON.stringify(downloadResults, null, 2));
      console.log(`\nDownload summary saved to ${resultsFilename}`);
    } catch (fileError) {
      console.error('Error saving results file:', fileError.message);
    }

    console.log(`\nDownload summary:`);
    let successCount = 0;
    let failCount = 0;
    let criticalErrorCount = 0;
    downloadResults.forEach(book => {
      if (book.success) {
        successCount++;
        console.log(`✅ ${book.title}: Downloaded successfully from ${book.pdfUrl}`);
      } else {
        failCount++;
        const errorType = book.criticalError ? '🔴 CRITICAL' : '❌ ERROR';
        if (book.criticalError) criticalErrorCount++;
        console.log(`${errorType} ${book.title}: ${book.error || 'Unknown error'}`);
      }
    });
    console.log(`\nTotal: ${downloadResults.length} | Successful: ${successCount} | Failed: ${failCount} | Critical Errors: ${criticalErrorCount}`);


  } catch (outerError) { // Outer try-catch for browser launch / major setup issues
    console.error('A critical error occurred (e.g., browser launch failed):', outerError.message);
    if (outerError.stack) console.error(outerError.stack);
  } finally {
    console.log('Scraping process is finishing. Ensuring browser is closed.');
    if (browser) {
      try {
        await browser.close();
        console.log('Browser closed successfully in outer finally.');
      } catch (closeError) {
        console.error('Error closing browser in outer finally:', closeError.message);
      }
    }
  }
}

// --- Main execution block ---
(async () => {
  const argv = yargs(hideBin(process.argv))
    .option('product-name', {
      alias: 'p',
      type: 'string',
      description: 'The product name (e.g., openshift_container_platform)',
      demandOption: true
    })
    .option('product-version', {
      alias: 'v',
      type: 'string',
      description: 'The product version (e.g., 4.18)',
      demandOption: true
    })
    .option('base-url', {
        alias: 'b',
        type: 'string',
        description: 'The base documentation URL',
        default: 'https://docs.redhat.com/en/documentation/'
    })
    .option('headless', {
        alias: 'H',
        type: 'boolean',
        description: 'Run the browser in headless mode (no UI). Default: true (headless). Use --no-headless for UI.',
        default: true
    })
    .help()
    .alias('help', 'h')
    .argv;

  const productName = argv.productName;
  const productVersion = argv.productVersion;
  const baseUrl = argv.baseUrl;
  const runHeadless = argv.headless;

  const urlProductName = productName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const urlProductVersion = productVersion;

  const targetUrl = `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}${urlProductName}/${urlProductVersion}`;
  await scrapeAndDownloadDocs(targetUrl, productName, productVersion, runHeadless);
})();

// --- END OF FILE docs-downloader.js ---