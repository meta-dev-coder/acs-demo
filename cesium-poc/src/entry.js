if (new URLSearchParams(location.search).get("demo") === "i595") {
  import("./i595Demo.js").catch(error => {
    // A module/network failure happens before i595Demo can replace the loader with its own error
    // UI. Keep the clean startup surface and turn it into a useful retry message.
    const loader = document.querySelector('#i595-boot-loader');
    loader?.querySelector('.i595-boot-loader-ring')?.remove();
    const title = loader?.querySelector('.i595-boot-loader-title');
    const note = loader?.querySelector('.i595-boot-loader-note');
    if (title) title.textContent = 'Unable to start the I-595 Digital Twin';
    if (note) note.textContent = 'Please check the connection and reload the page.';
    console.error(error);
  });
} else {
  import("./main.js");
}
