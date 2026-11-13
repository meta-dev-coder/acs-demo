import { LEGACY_PAGE, projectFor } from './projects.js';

const project = projectFor();

(project ?? LEGACY_PAGE).load().catch(error => {
  // A module or network failure happens before the page can replace the loader with its own error
  // UI. Keep the clean startup surface and turn it into a useful retry message.
  const loader = document.querySelector('#i595-boot-loader');
  loader?.querySelector('.i595-boot-loader-ring')?.remove();
  const title = loader?.querySelector('.i595-boot-loader-title');
  const note = loader?.querySelector('.i595-boot-loader-note');
  if (title) title.textContent = `Unable to start ${project?.label ?? 'the application'}`;
  if (note) note.textContent = 'Please check the connection and reload the page.';
  console.error(error);
});
