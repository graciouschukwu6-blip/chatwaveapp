// Theme
function getTheme() { return localStorage.getItem("cw_theme") || "dark"; }
function setTheme(theme) { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("cw_theme", theme); }
setTheme(getTheme());
document.getElementById("themeToggle").addEventListener("click", function() {
  setTheme(getTheme() === "dark" ? "light" : "dark");
});

var loginForm = document.getElementById("loginForm");
var registerForm = document.getElementById("registerForm");
var pinForm = document.getElementById("pinForm");
var errorMsg = document.getElementById("errorMsg");
var tempToken = null;

document.getElementById("showRegister").addEventListener("click", function(e) {
  e.preventDefault(); loginForm.classList.remove("active"); registerForm.classList.add("active"); pinForm.classList.remove("active"); errorMsg.style.display = "none";
});
document.getElementById("showLogin").addEventListener("click", function(e) {
  e.preventDefault(); registerForm.classList.remove("active"); loginForm.classList.add("active"); pinForm.classList.remove("active"); errorMsg.style.display = "none";
});
document.getElementById("backToLogin").addEventListener("click", function(e) {
  e.preventDefault(); pinForm.classList.remove("active"); loginForm.classList.add("active"); errorMsg.style.display = "none"; tempToken = null;
});

function showError(msg) { errorMsg.textContent = msg; errorMsg.style.display = "block"; }

// PIN box auto-advance
var pinBoxes = document.querySelectorAll('.pin-box');
pinBoxes.forEach(function(box, idx) {
  box.addEventListener('input', function(e) {
    var val = e.target.value.replace(/\D/g, '');
    e.target.value = val.charAt(0) || '';
    if (val && idx < pinBoxes.length - 1) {
      pinBoxes[idx + 1].focus();
    }
  });
  box.addEventListener('keydown', function(e) {
    if (e.key === 'Backspace' && !e.target.value && idx > 0) {
      pinBoxes[idx - 1].focus();
      pinBoxes[idx - 1].value = '';
    }
  });
  box.addEventListener('paste', function(e) {
    e.preventDefault();
    var paste = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
    for (var i = 0; i < Math.min(paste.length, pinBoxes.length); i++) {
      pinBoxes[i].value = paste[i];
    }
    var focusIdx = Math.min(paste.length, pinBoxes.length - 1);
    pinBoxes[focusIdx].focus();
  });
});

function getPinValue() {
  var pin = '';
  pinBoxes.forEach(function(b) { pin += b.value; });
  return pin;
}

function clearPinBoxes() {
  pinBoxes.forEach(function(b) { b.value = ''; });
  pinBoxes[0].focus();
}

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

    // Check if two-step PIN is required
    if (data.requires_pin) {
      tempToken = data.temp_token;
      loginForm.classList.remove("active");
      registerForm.classList.remove("active");
      pinForm.classList.add("active");
      errorMsg.style.display = "none";
      clearPinBoxes();
      return;
    }

    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    window.location.href = "/app";
  } catch (err) { showError("Connection error. Try again."); }
});

// Verify PIN button
document.getElementById("verifyPinBtn").addEventListener("click", async function() {
  var pin = getPinValue();
  if (pin.length !== 6) { showError("Enter all 6 digits"); return; }

  try {
    var res = await fetch("/api/auth/two-step/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pin, temp_token: tempToken })
    });
    var data = await res.json();
    if (!res.ok) { showError(data.error); clearPinBoxes(); return; }

    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    window.location.href = "/app";
  } catch(err) { showError("Connection error. Try again."); }
});

// Also trigger verify on last digit entered
pinBoxes[pinBoxes.length - 1].addEventListener('input', function() {
  if (getPinValue().length === 6) {
    document.getElementById("verifyPinBtn").click();
  }
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
