// Enhanced swipe UI for Like and Nope actions

const swipeContainer = document.querySelector('.swipe-container');
const likeStamp = document.createElement('div');
const nopeStamp = document.createElement('div');

likeStamp.className = 'stamp like';
nopeStamp.className = 'stamp nope';

function showStamp(type) {
    const stamp = type === 'like' ? likeStamp : nopeStamp;
    swipeContainer.appendChild(stamp);
    setTimeout(() => stamp.classList.add('visible'), 100);
    setTimeout(() => stamp.classList.remove('visible'), 1000);
}

function handleSwipe(direction) {
    if (direction === 'left') {
        showStamp('nope');
        // Handle Nope action
    } else if (direction === 'right') {
        showStamp('like');
        // Handle Like action
    }
}

// Improved gesture detection
let startX;

swipeContainer.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
});

swipeContainer.addEventListener('touchmove', (e) => {
    const moveX = e.touches[0].clientX;
    const diffX = moveX - startX;
    if (diffX > 50) {
        handleSwipe('right');
    } else if (diffX < -50) {
        handleSwipe('left');
    }
});

// Responsive Design CSS (embedded for simplicity)
const style = document.createElement('style');
style.innerHTML = `
.stamp {
    position: absolute;
    opacity: 0;
    transition: opacity 0.5s;
}
.stamp.visible {
    opacity: 1;
}
@media (max-width: 768px) {
    .swipe-container {
        width: 100%;
        height: auto;
    }
}
`;
document.head.appendChild(style);

// Initialize the swipe UI
swipeContainer.addEventListener('touchend', (e) => {
    // Logic to finalize the swipe action
});
