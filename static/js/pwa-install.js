/**
 * PathPulse PWA - Custom Installation Prompt Controller
 */

let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent Chrome 67 and earlier from automatically showing the prompt
  e.preventDefault();
  
  // Stash the event so it can be triggered later.
  deferredPrompt = e;
  
  // Update UI to notify the user they can install the PWA
  const installLi = document.getElementById('pwa-install-li');
  if (installLi) {
    installLi.style.display = 'block';
  }
  
  console.log('[PWA] beforeinstallprompt event fired. Install button is now visible.');
});

document.addEventListener('DOMContentLoaded', () => {
  const installBtn = document.getElementById('pwa-install-btn');
  
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) {
        console.warn('[PWA] Install prompt was clicked, but no deferredPrompt is available.');
        return;
      }
      
      // Show the install prompt
      deferredPrompt.prompt();
      
      // Wait for the user to respond to the prompt
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`[PWA] User response to the install prompt: ${outcome}`);
      
      // We've used the prompt, so we can't use it again; clear it
      deferredPrompt = null;
      
      // Hide the install button container
      const installLi = document.getElementById('pwa-install-li');
      if (installLi) {
        installLi.style.display = 'none';
      }
    });
  }
});

// Listener for post-installation
window.addEventListener('appinstalled', (event) => {
  console.log('[PWA] PathPulse AI was successfully installed!');
  
  // Hide install button container
  const installLi = document.getElementById('pwa-install-li');
  if (installLi) {
    installLi.style.display = 'none';
  }
  
  // Clear the stashed prompt
  deferredPrompt = null;
});
