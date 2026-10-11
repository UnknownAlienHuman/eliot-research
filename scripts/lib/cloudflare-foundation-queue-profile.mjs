/** Published S64 contour: one primary Queue and its own finite quarantine consumer. */
export function assertFoundationQueueConsumers(config, queues) {
  const primary = queues.filter(item => item.role === "primary");
  const deadLetters = queues.filter(item => item.role === "dead_letter");
  const consumers = config.queues?.consumers;
  if (primary.length !== 1 || deadLetters.length !== 1 || !Array.isArray(consumers) || consumers.length !== 2) {
    throw new Error("canonical Queue consumers must bind exactly one primary Queue and one DLQ");
  }
  const jobs = consumers.filter(item => item.queue === primary[0].name);
  const quarantine = consumers.filter(item => item.queue === deadLetters[0].name);
  if (jobs.length !== 1 || quarantine.length !== 1 || jobs[0].dead_letter_queue !== deadLetters[0].name ||
      quarantine[0].dead_letter_queue !== undefined) {
    throw new Error("canonical Queue primary/DLQ consumer identity or recursive dead-letter target differs");
  }
  return config;
}
