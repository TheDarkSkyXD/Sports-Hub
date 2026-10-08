for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', error => {
    if (error.code !== 'EPIPE') throw error;
  });
}
