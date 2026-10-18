export function createSseParser(onData: (data: string) => void): (chunk: string, flush?: boolean) => void {
  let buffer = "";
  return (chunk: string, flush = false) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const packet = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = packet
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onData(data);
      boundary = buffer.indexOf("\n\n");
    }
    if (flush && buffer.trim()) {
      const packet = buffer.trim();
      const data = packet
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onData(data);
      buffer = "";
    }
  };
}
