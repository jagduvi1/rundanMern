// One-shot Mailgun test send. Usage:
//   node scripts/test-email.js you@example.com
// Reads MAILGUN_API_KEY + MAILGUN_DOMAIN + EMAIL_FROM from backend/.env. On a
// Mailgun sandbox domain you can only send to pre-authorised recipients.
require('dotenv').config();

const email = require('../src/services/email');

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: node scripts/test-email.js <recipient@example.com>');
    process.exit(1);
  }
  if (!email.isEnabled()) {
    console.error('MAILGUN_API_KEY / MAILGUN_DOMAIN not set in backend/.env — aborting.');
    process.exit(1);
  }

  console.log(`Sending test email to ${to} from "${process.env.EMAIL_FROM}" ...`);
  try {
    const res = await email.send({
      to,
      subject: 'Rundan — Mailgun test',
      html: email.wrapTemplate({
        title: 'It works! 🎉',
        intro: 'This is a test email from Rundan via Mailgun. If you can read this, transactional email is wired up correctly.',
      }),
      text: 'It works! This is a test email from Rundan via Mailgun.',
    });
    console.log('✅ Accepted by Mailgun. Message id:', res?.id || '(no id returned)');
  } catch (err) {
    console.error('❌ Send failed:', err?.message || err);
    process.exit(1);
  }
}

main();
