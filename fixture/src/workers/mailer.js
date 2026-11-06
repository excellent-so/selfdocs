// A background worker: drains a queue and "sends" welcome mail.
export async function runMailerWorker(queue) {
  for (const job of queue) {
    await sendWelcome(job.email);
  }
}

async function sendWelcome(email) {
  // Pretend to hand off to an email provider.
  return { to: email, status: "queued" };
}
