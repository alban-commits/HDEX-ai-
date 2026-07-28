const port = process.env.PORT || "3000";
const target = process.env.HEALTHCHECK_URL || `http://127.0.0.1:${port}/api/health`;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 5_000);

try {
  const response = await fetch(target, { signal: controller.signal, redirect: "error" });
  const body = await response.text();
  if (!response.ok) {
    console.error(`healthcheck failed (${response.status}): ${body}`);
    process.exitCode = 1;
  } else {
    console.log(body);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
