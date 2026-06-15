// One-shot MailerSend test send. Usage:
//   node scripts/test-email.js you@example.com
// Reads MAILERSEND_API_KEY + EMAIL_FROM from backend/.env. On the trial test
// domain you can only send to your own MailerSend account email address.
require('dotenv').config();

const email = require('../src/services/email');

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: node scripts/test-email.js <recipient@example.com>');
    process.exit(1);
  }
  if (!email.isEnabled()) {
    console.error('MAILERSEND_API_KEY is not set in backend/.env — aborting.');
    process.exit(1);
  }

  console.log(`Sending test email to ${to} from "${process.env.EMAIL_FROM}" ...`);
  try {
    const res = await email.send({
      to,
      subject: 'Rundan — MailerSend test',
      html: email.wrapTemplate({
        title: 'It works! 🎉',
        intro: 'This is a test email from Rundan via MailerSend. If you can read this, transactional email is wired up correctly.',
      }),
      text: 'It works! This is a test email from Rundan via MailerSend.',
    });
    const id = res?.headers?.['x-message-id'] || res?.body?.message_id || '(no id returned)';
    console.log('✅ Accepted by MailerSend. Message id:', id);
  } catch (err) {
    console.error('❌ Send failed:', err?.body || err?.message || err);
    process.exit(1);
  }
}

main();
