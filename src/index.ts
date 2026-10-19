import http from 'http';
import Imap from 'imap';
import client from 'prom-client';
import Errorlogger from './Errorlogger';
import playwrightAutomation from './playwrightAutomation';

// --- 1. Rejestr i metryki Prometheusa ---
const register = new client.Registry();

// Opcjonalnie: zbieraj domyślne metryki Node.js (zużycie pamięci, CPU itp.)
client.collectDefaultMetrics({ register });

// Definicja metryki dla aktualizacji gospodarstwa domowego
const householdUpdatesCounter = new client.Counter({
  name: 'netflix_household_updates_total',
  help: 'Całkowita liczba udanych zmian/aktualizacji gospodarstwa domowego Netflix',
});

register.registerMetric(householdUpdatesCounter);


// --- 2. Serwer HTTP wystawiający /metrics dla Prometheusa ---
const METRICS_PORT = Number(process.env.METRICS_PORT) || 9090;

const server = http.createServer(async (req, res) => {
  if (req.url === '/metrics' && req.method === 'GET') {
    try {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.statusCode = 500;
      res.end(`Błąd generowania metryk: ${err}`);
    }
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

server.listen(METRICS_PORT, () => {
  console.log(`Serwer metryk Prometheusa działa pod adresem: http://localhost:${METRICS_PORT}/metrics`);
});


// --- 3. Logika IMAP i Playwright ---
function createImapClient() {
  return new Imap({
    user: process.env.IMAP_USER ?? '',
    password: process.env.IMAP_PASSWORD ?? '',
    host: process.env.IMAP_HOST ?? '',
    port: Number(process.env.IMAP_PORT) || 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    keepalive: {
      interval: 10000,
      idleInterval: 300000,
      forceNoop: true,
    },
  });
}

let imap = createImapClient();
let isConnecting = false;

function handleEmails() {
  imap.search([
    'UNSEEN',
    ['HEADER', 'FROM', process.env.TARGET_EMAIL_ADDRESS],
    ['HEADER', 'SUBJECT', process.env.TARGET_EMAIL_SUBJECT],
  ], (err, results) => {
    if (err) {
      new Errorlogger(`Search Error: ${err}`);
      return;
    }

    if (!results || !results.length) return;

    const fetchingData = imap.fetch(results, { bodies: 'TEXT', markSeen: true });
    
    fetchingData.on('message', (msg) => {
      let body = '';
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => {
          body += chunk.toString('utf-8');
        });

        stream.on('end', async () => {
          const quotedPrintable = body
            .replace(/=(\r?\n|$)/g, '')
            .replace(/=([a-f0-9]{2})/ig, (m, code) => String.fromCharCode(parseInt(code, 16)));
          
          const regex = /"(https:\/\/www\.netflix\.com\/account\/update-primary-location[^"]*)"/;
          const match = quotedPrintable.match(regex);

          if (match && match[1]) {
            try {
              const updatePrimaryLink = new URL(match[1]);
              await playwrightAutomation(updatePrimaryLink.toString());

              // Podbicie metryki po udanej operacji
              householdUpdatesCounter.inc();
              console.log('Zaktualizowano gospodarstwo domowe Netflix. Metryka podbita!');

            } catch (e) {
              new Errorlogger(e);
            }
          } else {
            new Errorlogger('no specific Netflix link in E-Mail found');
          }
        });
      });
    });

    fetchingData.on('error', (fetchingError) => {
      new Errorlogger(`Fetching Error: ${fetchingError}`);
    });
  });
}

function startImapListener() {
  if (isConnecting) return;
  isConnecting = true;

  imap.removeAllListeners();

  imap.once('ready', () => {
    isConnecting = false;
    imap.openBox('INBOX', false, (err) => {
      if (err) {
        new Errorlogger(`open INBOX Error => ${err}`);
        reconnect();
        return;
      }

      console.log('IMAP connection is ready, start listening Emails on INBOX');
      
      handleEmails();

      imap.on('mail', () => handleEmails());
    });
  });

  imap.on('error', (err: Error) => {
    isConnecting = false;
    new Errorlogger(`IMAP Error captured: ${err.message}`);
    
    reconnect();
  });

  imap.once('end', () => {
    isConnecting = false;
    console.log('IMAP connection ended');
    reconnect();
  });

  imap.connect();
}

function reconnect() {
  try {
    imap.destroy();
  } catch (_) {}

  console.log('Reconnecting IMAP in 10 seconds...');
  setTimeout(() => {
    imap = createImapClient();
    startImapListener();
  }, 10000);
}

startImapListener();