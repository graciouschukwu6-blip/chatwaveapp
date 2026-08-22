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
  var body = { login: login };
  body["password"] = pin;
  try {
    var res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
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
  var body = { username: username, email: email };
  body["password"] = pin;
  try {
    var res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    var data = await res.json();
    if (!res.ok) { showError(data.error); return; }
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    window.location.href = "/app";
  } catch (err) { showError("Connection error. Try again."); }
});

// Only redirect to /app if token is valid
(async function() {
  var savedToken = localStorage.getItem("token");
  if (savedToken) {
    try {
      var res = await fetch("/api/auth/me", { headers: { "Authorization": "Bearer " + savedToken } });
      if (res.ok) {
        window.location.href = "/app";
      } else {
        localStorage.clear();
      }
    } catch(e) {
      localStorage.clear();
    }
  }
})();
