/* ============================================
   Department of Data Science — University of Uyo
   script.js — All Features
   ============================================ */

/* 1. BANNER SLIDESHOW
   Add photos: put file in folder, add filename below.
   Remove photos: delete its line below.
   Slides change every 2.5 seconds. */
const bannerImages = [
  "banner1.jpg",
  "banner2.jpg",
  "banner3.jpg",
  "banner4.jpg"
];

function initBannerSlideshow() {
  const banner = document.getElementById('banner');
  const dotsWrap = document.getElementById('bannerDots');
  if (!banner || bannerImages.length === 0) return;

  bannerImages.forEach((src, i) => {
    const slide = document.createElement('div');
    slide.className = 'banner-slide' + (i === 0 ? ' active' : '');
    slide.style.backgroundImage = `url('${src}')`;
    banner.insertBefore(slide, banner.firstChild);

    const dot = document.createElement('span');
    dot.className = 'banner-dot' + (i === 0 ? ' active' : '');
    dot.addEventListener('click', () => goToSlide(i));
    dotsWrap.appendChild(dot);
  });

  let current = 0;
  const slides = banner.querySelectorAll('.banner-slide');
  const dots = dotsWrap.querySelectorAll('.banner-dot');

  function goToSlide(index) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = index;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
  }

  if (bannerImages.length > 1) {
    setInterval(() => goToSlide((current + 1) % bannerImages.length), 2500);
  }
}

/* 2. INTRO ANIMATION
   The logo spins for 3 seconds then fades out.
   After it's gone, a welcome toast appears. */
function initIntro() {
  const overlay = document.getElementById('introOverlay');
  if (!overlay) return;
  setTimeout(() => {
    overlay.style.display = 'none';
    showToast('Welcome to Department of Data Science, UNIUYO');
  }, 3600);
}

/* 3. MOBILE MENU */
function initMobileMenu() {
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');
  if (!hamburger || !navLinks) return;
  hamburger.addEventListener('click', () => navLinks.classList.toggle('open'));
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => navLinks.classList.remove('open'));
  });
}

/* 4. FADE IN ON SCROLL
   Sections with class "fade-in" animate in
   when they enter the viewport. */
function initFadeInOnScroll() {
  const fadeEls = document.querySelectorAll('.fade-in');
  if (!fadeEls.length) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });
  fadeEls.forEach(el => observer.observe(el));
}

/* 5. PARTICLE CANVAS BACKGROUND
   Draws animated data network dots on the banner.
   Gold dots connect to nearby dots with thin lines. */
function initParticles() {
  const canvas = document.getElementById('particleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let particles = [];

  function resize() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < 60; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      size: Math.random() * 2.5 + 0.5
    });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(127,214,247,0.65)';
      ctx.fill();
    });
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0,168,232,${0.25 * (1 - dist / 100)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
}

/* 6. TYPING EFFECT
   Types out 3 phrases one by one on the headline.
   Starts after the intro animation finishes. */
function initTypingEffect() {
  const el = document.getElementById('typingText');
  if (!el) return;

  const phrases = [
    'Turning Data Into Insight',
    'Building Nigeria\'s Data Future',
    'Where Analytics Meets Excellence'
  ];

  let phraseIndex = 0, charIndex = 0, isDeleting = false;

  function type() {
    const current = phrases[phraseIndex];
    el.textContent = isDeleting
      ? current.substring(0, charIndex - 1)
      : current.substring(0, charIndex + 1);

    isDeleting ? charIndex-- : charIndex++;

    let speed = isDeleting ? 50 : 80;
    if (!isDeleting && charIndex === current.length) { speed = 2000; isDeleting = true; }
    else if (isDeleting && charIndex === 0) {
      isDeleting = false;
      phraseIndex = (phraseIndex + 1) % phrases.length;
      speed = 400;
    }
    setTimeout(type, speed);
  }
  setTimeout(type, 3800);
}

/* 7. ANIMATED STAT COUNTERS
   Numbers count up from 0 when the stats
   section scrolls into view. */
function initCounters() {
  const section = document.getElementById('statsSection');
  if (!section) return;
  let counted = false;
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !counted) {
      counted = true;
      document.querySelectorAll('.counter').forEach(counter => {
        const target = parseInt(counter.dataset.target);
        const suffix = counter.dataset.suffix || '';
        let current = 0;
        const increment = target / 60;
        const update = () => {
          current += increment;
          if (current < target) {
            counter.textContent = Math.floor(current) + suffix;
            requestAnimationFrame(update);
          } else {
            counter.textContent = target + suffix;
          }
        };
        update();
      });
    }
  }, { threshold: 0.5 }).observe(section);
}

/* 9. LIVE NIGERIAN TIME (WAT)
   West Africa Time = UTC + 1 hour.
   Updates every second. */
function initLiveTime() {
  const el = document.getElementById('liveTime');
  if (!el) return;
  function update() {
    const now = new Date();
    const wat = new Date(now.getTime() + (60 * 60 * 1000));
    const h = String(wat.getUTCHours()).padStart(2, '0');
    const m = String(wat.getUTCMinutes()).padStart(2, '0');
    const s = String(wat.getUTCSeconds()).padStart(2, '0');
    el.innerHTML = `<i class="fas fa-clock"></i> ${h}:${m}:${s} WAT`;
  }
  update();
  setInterval(update, 1000);
}

/* 10. PROGRESS RING SCROLL-TO-TOP
    The ring fills as you scroll down.
    Circumference of circle (r=20) = 2*PI*20 = 125.6 */
function initProgressRing() {
  const wrap = document.getElementById('progressRingWrap');
  const fill = document.getElementById('progressRingFill');
  const btn = document.getElementById('progressRingBtn');
  if (!wrap || !fill || !btn) return;
  const circumference = 125.6;
  window.addEventListener('scroll', () => {
    const scrolled = window.scrollY;
    const total = document.documentElement.scrollHeight - window.innerHeight;
    const progress = scrolled / total;
    wrap.classList.toggle('visible', scrolled > 300);
    fill.style.strokeDashoffset = circumference - (progress * circumference);
  });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

/* 11. SCROLL PROGRESS BAR
    The red line at the top fills as you scroll. */
function initScrollProgressBar() {
  const bar = document.getElementById('scrollProgressBar');
  if (!bar) return;
  window.addEventListener('scroll', () => {
    const scrolled = window.scrollY;
    const total = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = ((scrolled / total) * 100) + '%';
  });
}

/* 12. RIPPLE EFFECT ON BUTTONS
    A circle expands from the tap point
    when any button is clicked. */
function initRippleEffect() {
  document.querySelectorAll('.ripple-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      const rect = this.getBoundingClientRect();
      const ripple = document.createElement('span');
      const size = Math.max(rect.width, rect.height);
      ripple.className = 'ripple';
      ripple.style.left = (e.clientX - rect.left) + 'px';
      ripple.style.top = (e.clientY - rect.top) + 'px';
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.marginLeft = ripple.style.marginTop = -(size / 2) + 'px';
      this.appendChild(ripple);
      setTimeout(() => ripple.remove(), 700);
    });
  });
}

/* 13. GALLERY LIGHTBOX
    Tap any gallery photo to expand it fullscreen.
    Tap X or the dark backdrop to close it. */
function initLightbox() {
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const closeBtn = document.getElementById('lightboxClose');
  const backdrop = document.getElementById('lightboxBackdrop');
  if (!lightbox) return;

  document.querySelectorAll('.gallery-img').forEach(img => {
    img.addEventListener('click', () => {
      lightboxImg.src = img.src;
      lightbox.classList.add('open');
      document.body.style.overflow = 'hidden';
    });
  });

  function close() { lightbox.classList.remove('open'); document.body.style.overflow = ''; }
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);
}

/* 14. FAQ ACCORDION
    One FAQ opens at a time. */
function initFAQ() {
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', function() {
      const item = this.parentElement;
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
  });
}

/* 16. TOAST NOTIFICATION
    Call showToast('message') anywhere to
    show a popup message at the bottom. */
function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3400);
}

/* 18. ACTIVE NAV HIGHLIGHT
    Automatically highlights the current
    page link in the nav bar. */
function initActiveNav() {
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(link => {
    link.classList.remove('nav-active');
    if (link.getAttribute('href') === currentPage ||
       (currentPage === '' && link.getAttribute('href') === 'index.html')) {
      link.classList.add('nav-active');
    }
  });
}



/* 19. DATABASE-BACKED PUBLIC NEWS
   Announcements posted by an administrator to the main website are loaded here. */
function escapePublicNews(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

async function initPublicNews() {
  const list = document.getElementById('public-news-list');
  if (!list) return;
  try {
    const response = await fetch('/api/public/announcements', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.announcements) || !data.announcements.length) return;
    list.innerHTML = data.announcements.map(item => {
      const date = new Date(item.created_at);
      const day = Number.isNaN(date.getTime()) ? '' : String(date.getDate()).padStart(2, '0');
      const month = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-NG', { month: 'short' }).toUpperCase();
      return `<div class="news-item">
        <span class="news-date"><i class="fas fa-calendar-alt"></i> ${day} ${month}</span>
        <span class="news-text"><strong>${escapePublicNews(item.title)}</strong><br>${escapePublicNews(item.body)}</span>
      </div>`;
    }).join('');
  } catch (error) {
    console.warn('Could not load database announcements:', error);
  }
}

/* RUN EVERYTHING */
document.addEventListener('DOMContentLoaded', () => {
  initIntro();
  initBannerSlideshow();
  initMobileMenu();
  initFadeInOnScroll();
  initParticles();
  initTypingEffect();
  initCounters();
  initLiveTime();
  initProgressRing();
  initScrollProgressBar();
  initRippleEffect();
  initLightbox();
  initFAQ();
  initActiveNav();
  initPublicNews();
});