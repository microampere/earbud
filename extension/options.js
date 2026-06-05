const apiKeyInput = document.getElementById('api-key');
const modelSelect = document.getElementById('model');
const saveBtn = document.getElementById('save-btn');
const savedMsg = document.getElementById('saved-msg');

chrome.storage.local.get(['apiKey', 'model'], ({ apiKey, model }) => {
  if (apiKey) apiKeyInput.value = apiKey;
  if (model) modelSelect.value = model;
});

saveBtn.addEventListener('click', () => {
  const apiKey = apiKeyInput.value.trim();
  const model = modelSelect.value;
  chrome.storage.local.set({ apiKey, model }, () => {
    savedMsg.classList.add('visible');
    setTimeout(() => savedMsg.classList.remove('visible'), 2000);
  });
});
