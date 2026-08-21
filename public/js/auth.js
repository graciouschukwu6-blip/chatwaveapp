// Theme
function getTheme() { return localStorage.getItem("cw_theme") || "dark"; }
function setTheme(theme) { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("cw_theme", theme); }
setTheme(getTheme());
document.getElementById("themeToggle").addEventListener("click", function() {
  setTheme(getTheme() === "dark" ? "light" : "dark");
});

var loginForm = document.getElementById("loginForm");
var registerForm = document.getElementById("registerForm");
var errorMsg = document.getElementById("errorMsg");

document.getElementById("showRegister").addEventListener("click", function(e) {
  e.preventDefault(); loginForm.classList.remove("active"); registerForm.classList.add("active"); errorMsg.style.display = "none";
});
document.getElementById("showLogin").addEventListener("click", function(e) {
  e.preventDefault(); registerForm.classList.remove("active"); loginForm.classList.add("active"); errorMsg.style.display = "none";
});

function showError(msg) { errorMsg.textContent = msg; errorMsg.style.display = "block"; }

loginForm.addEventListener("submit", async function(e) {
  e.preventDefault();
  var login = document.getElementById("loginInput").value.trim();
  var pin = document.getElementById("loginSecret").value;
  try {
    var res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: login, password: pin })
    });
    var data = await res.json();
    if (!res.ok) { showError(data.error); return; }
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    window.location.href = "/app";
  } catch (err) { showError("Connection error. Try again."); }
});

registerForm.addEventListener("submit", async function(e) {
  e.preventDefault();
  var username = document.getElementById("regUsername").value.trim();
  var email = document.getElementById("regEmail").value.trim();
  var pin = document.getElementById("regSecret").value;
  try {
    var res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, email: email, password: pin })
    });
    var data = await res.json();
    if (!res.ok) { showError(data.error); return; }
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    window.location.href = "/app";
  } catch (err) { showError("Connection error. Try again."); }
});

if (localStorage.getItem("token")) { window.location.href = "/app"; }