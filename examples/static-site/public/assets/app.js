const API_URL = "__API_URL__";

document.getElementById("call-edge").addEventListener("click", async () => {
  const result = document.getElementById("edge-result");
  result.textContent = "calling…";
  try {
    const response = await fetch(`${API_URL}/hello`);
    result.textContent = JSON.stringify(await response.json(), null, 2);
  } catch (error) {
    result.textContent = `failed: ${error}`;
  }
});
