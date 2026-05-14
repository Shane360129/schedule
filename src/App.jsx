import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  ChevronLeft, ChevronRight, X, Sparkles, Clock, Trash2, 
  Loader2, Save, AlignLeft, Leaf, CheckSquare, Plus, Edit, Coffee, Settings, Copy, User, Users, CalendarHeart, Palette, Check, AlertCircle, Type, Download, List, AlertTriangle
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, onAuthStateChanged, signInAnonymously 
} from 'firebase/auth';
import { 
  getFirestore, collection, query, onSnapshot, addDoc, updateDoc, deleteDoc, doc, setDoc, getDoc, arrayUnion
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAaeMl8u3S8Atf5b9Z4MvYRfxNWqyxjvck",
  authDomain: "schdule-f5cda.firebaseapp.com",
  projectId: "schdule-f5cda",
  storageBucket: "schdule-f5cda.firebasestorage.app",
  messagingSenderId: "318490887020",
  appId: "1:318490887020:web:115d4b35f544455768e949",
  measurementId: "G-Q7ZEKV7YEH"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = 'schdule-f5cda';

// --- Helper: Haptic Feedback ---
const triggerHaptic = () => {
  if (navigator.vibrate) {
    navigator.vibrate(10); 
  }
};

// --- Fonts ---
const FONTS = {
  naikai: { id: 'naikai', name: '內海字體', bodyClass: 'font-naikai', numClass: 'font-num-naikai' },
};

// --- Themes ---
const THEMES = {
  original: {
    id: 'original',
    name: '日和拿鐵',
    colors: {
      bg: '#FAF9F6', text: '#5F524C', secondaryText: '#998B82', headerBg: '#F5F0EB',
      gridHeaderBg: '#EBE5DF', gridBg: '#FFFFFF', gridEmptyBg: '#FAF9F6', gridWeekendBg: '#F7F3F0',
      border: '#E0D6CC', accent: '#BCAAA4', weekendText: '#C88A8A', weekdayText: '#A18E84',
      modalBg: '#FFFFFF', modalHeaderBg: '#F5F0EB', inputBg: '#FFFFFF', inputBorder: '#E0D6CC', danger: '#D48888'
    }
  },
  kuromi: {
    id: 'kuromi',
    name: '粉紅戀愛', 
    colors: {
      bg: '#FFF9FB', text: '#5E4048', secondaryText: '#9C8288', headerBg: '#FFF0F5',
      gridHeaderBg: '#FCE4EC', gridBg: '#FFFFFF', gridEmptyBg: '#FFF9FB80', gridWeekendBg: '#FFF0F3',
      border: '#F3D0D9', accent: '#D07890', weekendText: '#C06C84', weekdayText: '#D8A7B1',
      modalBg: '#FFFFFF', modalHeaderBg: '#FFF0F5', inputBg: '#FFFFFF', inputBorder: '#F3D0D9', danger: '#E57373'
    }
  },
  minimal: {
    id: 'minimal',
    name: '極簡純白', 
    colors: {
      bg: '#FFFFFF', text: '#000000', secondaryText: '#4B5563', headerBg: '#FFFFFF',
      gridHeaderBg: '#F3F4F6', gridBg: '#FFFFFF', gridEmptyBg: '#FAFAFA', gridWeekendBg: '#F9FAFB',
      border: '#D1D5DB', accent: '#000000', weekendText: '#DC2626', weekdayText: '#374151',
      modalBg: '#FFFFFF', modalHeaderBg: '#F9FAFB', inputBg: '#FFFFFF', inputBorder: '#9CA3AF', danger: '#B91C1C'
    }
  },
  onepiece: {
    id: 'onepiece',
    name: '航海王', // Soft Pastel Blue Theme
    colors: {
      bg: '#F0F9FF',          // Alice Blue (Very soft)
      text: '#455A64',        // Blue Grey (Softer than black)
      secondaryText: '#90A4AE', 
      headerBg: '#E3F2FD',    // Soft Blue Header
      gridHeaderBg: '#FFF59D', // Soft Straw Hat Yellow (Secondary ID)
      gridBg: '#FFFFFF',      
      gridEmptyBg: '#F0F9FF80', 
      gridWeekendBg: '#FFEBEE', // Soft Red tint for weekends
      border: '#81D4FA',      // Soft Blue Border
      accent: '#4FC3F7',      // Soft Blue Accent
      weekendText: '#E57373', // Soft Red
      weekdayText: '#0277BD', // Ocean Blue
      modalBg: '#FFFFFF',
      modalHeaderBg: '#E3F2FD', 
      inputBg: '#FFFFFF',
      inputBorder: '#81D4FA', 
      danger: '#EF5350'       // Soft Red
    }
  }
};

// --- Palette (Techo + Morandi + Pastels) ---
const TECHO_COLORS = {
  smokedPlum: { name: '煙燻梅', hex: '#8E4A49', text: '#FFFFFF' },
  ironBlue: { name: '鐵藍灰', hex: '#546E7A', text: '#FFFFFF' },
  mossGreen: { name: '苔蘚綠', hex: '#556B2F', text: '#FFFFFF' },
  ocher: { name: '赭石黃', hex: '#B8860B', text: '#FFFFFF' },
  latte: { name: '深咖啡', hex: '#6D4C41', text: '#FFFFFF' },
  tea: { name: '重焙茶', hex: '#A1887F', text: '#FFFFFF' },
  mist: { name: '暴風藍', hex: '#78909C', text: '#FFFFFF' },
  sakura: { name: '乾燥櫻', hex: '#EC407A', text: '#FFFFFF' },
  mint: { name: '松針綠', hex: '#26A69A', text: '#FFFFFF' },
  lemon: { name: '蜂蜜黃', hex: '#C0CA33', text: '#FFFFFF' },
  lavender: { name: '紫羅蘭', hex: '#7E57C2', text: '#FFFFFF' },
  slate: { name: '岩石灰', hex: '#475569', text: '#FFFFFF' },
  pastelSakura: { name: '櫻花氣泡', hex: '#F8BBD0', text: '#880E4F' }, 
  pastelPeach: { name: '蜜桃烏龍', hex: '#FFCCBC', text: '#BF360C' }, 
  pastelCream: { name: '雲朵棉花', hex: '#FFF9C4', text: '#827717' }, 
  pastelMatcha: { name: '抹茶牛奶', hex: '#DCEDC8', text: '#33691E' }, 
  pastelSky: { name: '冰河藍', hex: '#B3E5FC', text: '#01579B' },    
  pastelTaro: { name: '香芋慕斯', hex: '#E1BEE7', text: '#4A148C' },  
  pastelBeige: { name: '燕麥奶', hex: '#F5F5DC', text: '#5D4037' },   
  pastelGrey: { name: '晨霧灰', hex: '#CFD8DC', text: '#37474F' },    
};

// Fallback Holidays (2025-2027)
const FALLBACK_HOLIDAYS = {
  // 2025
  "2025-01-01": { isHoliday: true, name: "元旦" },
  "2025-01-25": { isHoliday: true, name: "除夕" },
  "2025-01-26": { isHoliday: true, name: "春節" },
  "2025-01-27": { isHoliday: true, name: "春節" },
  "2025-01-28": { isHoliday: true, name: "春節" },
  "2025-02-28": { isHoliday: true, name: "和平紀念日" },
  "2025-04-03": { isHoliday: true, name: "兒童節" },
  "2025-04-04": { isHoliday: true, name: "清明節" },
  "2025-05-31": { isHoliday: true, name: "端午節" },
  "2025-10-06": { isHoliday: true, name: "中秋節" },
  "2025-10-10": { isHoliday: true, name: "國慶日" },
  // 2026
  "2026-01-01": { isHoliday: true, name: "元旦" },
  "2026-02-17": { isHoliday: true, name: "春節" },
  // 2027
  "2027-01-01": { isHoliday: true, name: "元旦" },
  "2027-02-05": { isHoliday: true, name: "除夕" },
  "2027-02-06": { isHoliday: true, name: "春節" },
};

const getDaysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
const getFirstDayOfMonth = (year, month) => new Date(year, month, 1).getDay();
const formatDate = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

// --- Error Boundary ---
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, errorInfo) { console.error("UI Crash:", error, errorInfo); }
  handleReset = () => { localStorage.clear(); window.location.reload(); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-dvh flex flex-col items-center justify-center bg-[#F5F1E9] text-[#5D4037] p-6 text-center font-sans">
          <div className="bg-red-100 p-4 rounded-full mb-4"><AlertTriangle className="w-10 h-10 text-red-500" /></div>
          <h1 className="text-xl font-bold mb-2">哎呀，應用程式出錯了</h1>
          <p className="mb-6 text-sm opacity-70">可能是資料讀取錯誤或快取衝突。</p>
          <button onClick={this.handleReset} className="bg-[#5D4037] text-white px-6 py-3 rounded-xl shadow-md font-bold hover:opacity-90 transition-opacity active:scale-95">重置並重新整理</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Toast Component ---
const ToastContainer = ({ toasts }) => {
  return (
    <div className="fixed bottom-6 left-0 right-0 flex flex-col items-center gap-2 pointer-events-none z-[100]">
      {toasts.map(toast => (
        <div key={toast.id} className="toast-enter bg-gray-800/90 text-white px-4 py-2 rounded-full shadow-lg text-sm font-bold flex items-center gap-2 backdrop-blur-sm">
           {toast.type === 'success' && <Check className="w-4 h-4 text-green-400" />}
           {toast.type === 'error' && <AlertCircle className="w-4 h-4 text-red-400" />}
           {toast.message}
        </div>
      ))}
    </div>
  );
};

// --- Holiday Animation Component ---
const HolidayAnimation = ({ type, onDismiss }) => {
   if (!type) return null;
   let content = null;
   let bgColor = 'bg-black/80';
   
   switch(type) {
     case 'cny': 
       content = (<div className="text-center animate-bounce"><div className="text-9xl mb-4 animate-shake-crazy">🧨</div><div className="text-6xl animate-pulse">🧧</div><h2 className="text-white text-4xl font-bold mt-8 font-num-naikai">新年快樂!</h2></div>);
       bgColor = 'bg-red-900/90';
       break;
     case 'dragon':
       content = (<div className="text-center"><div className="text-9xl animate-float-slow">🐲</div><div className="text-6xl mt-4 animate-float-fast delay-100">🛶</div><h2 className="text-white text-4xl font-bold mt-8 font-num-naikai">端午安康</h2></div>);
       bgColor = 'bg-emerald-900/90';
       break;
     case 'moon':
       content = (<div className="text-center"><div className="text-9xl animate-spin-slow">🌕</div><div className="text-6xl mt-4 animate-bounce">🐇</div><h2 className="text-white text-4xl font-bold mt-8 font-num-naikai">中秋團圓</h2></div>);
       bgColor = 'bg-slate-900/90';
       break;
     case 'xmas':
       content = (<div className="text-center relative"><div className="absolute inset-0 pointer-events-none">{[...Array(10)].map((_, i) => (<div key={i} className="text-2xl absolute animate-snow-fall" style={{ left: `${Math.random()*100}%`, animationDelay: `${Math.random()*5}s` }}>❄️</div>))}</div><div className="text-9xl animate-sway">🎄</div><div className="text-6xl mt-2">🎅</div><h2 className="text-white text-4xl font-bold mt-8 font-num-naikai">Merry Christmas</h2></div>);
       bgColor = 'bg-green-900/90';
       break;
     case 'love':
       content = (<div className="text-center"><div className="text-9xl animate-heartbeat text-red-500">💖</div><div className="text-6xl mt-4 animate-float-slow">💌</div><h2 className="text-white text-4xl font-bold mt-8 font-num-naikai">Happy Valentine's</h2></div>);
       bgColor = 'bg-pink-900/90';
       break;
     default: return null;
   }
   return (
     <div className={`fixed inset-0 z-[100] flex items-center justify-center ${bgColor} backdrop-blur-md transition-all duration-500 cursor-pointer`} onClick={onDismiss}>
       {content}
       <div className="absolute bottom-10 text-white/50 text-sm">點擊螢幕關閉特效</div>
     </div>
   );
};

const App = () => {
  const [user, setUser] = useState(null);
  const [customUserId, setCustomUserId] = useState(localStorage.getItem('bibi_custom_uid') || '');
  
  const [currentDate, setCurrentDate] = useState(() => {
      const savedDate = localStorage.getItem('bibi_last_view_date');
      return savedDate && !isNaN(new Date(savedDate).getTime()) ? new Date(savedDate) : new Date();
  });

  const [slideDirection, setSlideDirection] = useState(''); 
  const [animationKey, setAnimationKey] = useState(0); 
  
  const [events, setEvents] = useState([]);
  const [roleSettings, setRoleSettings] = useState({ role1: '我', role2: '夥伴' });
  
  // Theme State
  const [currentThemeId, setCurrentThemeId] = useState(localStorage.getItem('bibi_theme') || 'original');
  const theme = THEMES[currentThemeId] || THEMES.original;

  // Font State (Locked to NaikaiFont)
  const currentFont = FONTS.naikai;

  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false); 
  const [toasts, setToasts] = useState([]);
  const [holidayType, setHolidayType] = useState(null);
  
  // Initial Holiday Data
  const [holidayData, setHolidayData] = useState(() => {
    const initialData = {};
    Object.entries(FALLBACK_HOLIDAYS).forEach(([date, info]) => {
        const y = parseInt(date.split('-')[0]);
        if (!initialData[y]) initialData[y] = {};
        initialData[y][date] = info;
    });
    return initialData;
  });

  // Modals
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDayViewModalOpen, setIsDayViewModalOpen] = useState(false); 
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false); 
  const [isUpcomingModalOpen, setIsUpcomingModalOpen] = useState(false);

  const [viewingDate, setViewingDate] = useState(null);
  const [editingId, setEditingId] = useState(null);

  const [formTitle, setFormTitle] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formStartDate, setFormStartDate] = useState('');
  const [formEndDate, setFormEndDate] = useState('');
  const [formIsAllDay, setFormIsAllDay] = useState(true);
  const [formStartTime, setFormStartTime] = useState('09:00');
  const [formEndTime, setFormEndTime] = useState('10:00');
  const [formColor, setFormColor] = useState('latte');
  const [formEventType, setFormEventType] = useState('common');

  const [tempRole1, setTempRole1] = useState('');
  const [tempRole2, setTempRole2] = useState('');

  const [deferredPrompt, setDeferredPrompt] = useState(null);

  const touchStartX = useRef(null);
  const touchEndX = useRef(null);
  const minSwipeDistance = 50;
  const toastIdRef = useRef(0);

  const addToast = (message, type = 'success') => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => { setToasts(prev => prev.filter(t => t.id !== id)); }, 3000);
  };
  
  useEffect(() => {
    localStorage.setItem('bibi_last_view_date', currentDate.toISOString());
  }, [currentDate]);

  useEffect(() => {
    const initAuth = async () => {
      try { await signInAnonymously(auth); } 
      catch (e) { console.error("Auth Failed:", e); setLoading(false); addToast('登入失敗，請檢查網路連線', 'error'); }
    };
    initAuth();
    return onAuthStateChanged(auth, (u) => { setUser(u); if(u) setLoading(false); });
  }, []);
  
  useEffect(() => {
    const timer = setTimeout(() => { if(loading) { console.warn("Forced loading stop due to timeout"); setLoading(false); } }, 8000);
    return () => clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setDeferredPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (isEditModalOpen) setIsEditModalOpen(false);
      else if (isUpcomingModalOpen) setIsUpcomingModalOpen(false);
      else if (isDayViewModalOpen) setIsDayViewModalOpen(false);
      else if (isSettingsModalOpen) setIsSettingsModalOpen(false);
      else if (holidayType) setHolidayType(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isEditModalOpen, isUpcomingModalOpen, isDayViewModalOpen, isSettingsModalOpen, holidayType]);

  const handleInstallApp = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setDeferredPrompt(null);
  };

  useEffect(() => {
    document.body.style.backgroundColor = theme.colors.bg;
    document.body.style.color = theme.colors.text;
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if(metaThemeColor) metaThemeColor.setAttribute('content', theme.colors.bg);
  }, [currentThemeId]);

  useEffect(() => {
    const checkHoliday = () => {
       const today = new Date();
       const y = today.getFullYear();
       const todayStr = formatDate(today);
       const md = todayStr.substring(5);
       if (md === '12-25') { setHolidayType('xmas'); return; }
       if (md === '02-14') { setHolidayType('love'); return; }
       const hInfo = holidayData[y]?.[todayStr];
       if (hInfo) {
          const name = hInfo.name;
          if (name.includes('春節') || name.includes('除夕') || name.includes('過年')) { setHolidayType('cny'); return; }
          if (name.includes('端午')) { setHolidayType('dragon'); return; }
          if (name.includes('中秋')) { setHolidayType('moon'); return; }
       }
    };
    setTimeout(checkHoliday, 1000);
  }, [holidayData]);

  // [FIX] Optimized Holiday Fetch with Fallback Generation
  useEffect(() => {
    const currentYear = currentDate.getFullYear();
    
    const generateFixedHolidays = (y) => ({
        [`${y}-01-01`]: { isHoliday: true, name: "元旦" },
        [`${y}-02-28`]: { isHoliday: true, name: "和平紀念日" },
        [`${y}-04-04`]: { isHoliday: true, name: "兒童節" },
        [`${y}-04-05`]: { isHoliday: true, name: "清明節" },
        [`${y}-05-01`]: { isHoliday: true, name: "勞動節" },
        [`${y}-10-10`]: { isHoliday: true, name: "國慶日" },
        [`${y}-12-25`]: { isHoliday: false, name: "聖誕節" },
        [`${y}-02-14`]: { isHoliday: false, name: "情人節" },
    });

    const fetchHolidays = async () => {
      try {
        console.log(`Fetching holidays for ${currentYear} from API...`);
        const response = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${currentYear}.json`);
        
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        
        const rawData = await response.json();
        const formatted = rawData.reduce((acc, curr) => {
          const dStr = curr.date;
          if (dStr && dStr.length === 8) {
             const ymd = `${dStr.substring(0, 4)}-${dStr.substring(4, 6)}-${dStr.substring(6, 8)}`;
             acc[ymd] = { isHoliday: curr.isHoliday, name: curr.description };
          }
          return acc;
        }, {});
        
        // Merge API data
        setHolidayData(prev => ({ ...prev, [currentYear]: formatted }));
        console.log(`Loaded holidays for ${currentYear}`);

      } catch (err) { 
          console.warn(`Failed to fetch holidays for ${currentYear}, generating fixed holidays fallback.`, err);
          const fixedHolidays = generateFixedHolidays(currentYear);
          setHolidayData(prev => {
              const existingData = prev[currentYear] || {};
              return { 
                  ...prev, 
                  [currentYear]: { ...fixedHolidays, ...existingData } 
              };
          });
      }
    };
    
    fetchHolidays();
  }, [currentDate.getFullYear()]);

  useEffect(() => {
    const targetUid = customUserId || user?.uid;
    if (!targetUid) return;
    const qEvents = query(collection(db, 'artifacts', appId, 'users', targetUid, 'bibi_events'));
    const unsubEvents = onSnapshot(qEvents, (snapshot) => {
      const loadedEvents = [];
      snapshot.forEach((doc) => loadedEvents.push({ id: doc.id, ...doc.data() }));
      setEvents(loadedEvents);
      setLoading(false);
    }, (err) => { console.error("Firestore Events Error:", err); setLoading(false); addToast('資料讀取失敗，請重試', 'error'); });

    const settingsDocRef = doc(db, 'artifacts', appId, 'users', targetUid, 'bibi_settings', 'roles');
    const unsubSettings = onSnapshot(settingsDocRef, (docSnap) => { if (docSnap.exists()) setRoleSettings(docSnap.data()); });

    return () => { unsubEvents(); unsubSettings(); };
  }, [user, customUserId]);

  const handleSaveCustomUid = () => { localStorage.setItem('bibi_custom_uid', customUserId); window.location.reload(); };
  const handleResetUid = () => { localStorage.removeItem('bibi_custom_uid'); window.location.reload(); };
  const handleCopyId = () => {
    const text = user?.uid;
    if (!text) return;
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try { document.execCommand('copy'); addToast('ID 已複製！'); } catch (err) {}
    document.body.removeChild(textArea);
  };

  const handleSaveRoles = async () => {
    const targetUid = customUserId || user?.uid;
    if (!targetUid) return;
    const newRoles = { role1: tempRole1 || roleSettings.role1, role2: tempRole2 || roleSettings.role2 };
    try { await setDoc(doc(db, 'artifacts', appId, 'users', targetUid, 'bibi_settings', 'roles'), newRoles); setRoleSettings(newRoles); setIsSettingsModalOpen(false); addToast('角色名稱已儲存 ✨'); } catch (e) { addToast('儲存失敗', 'error'); }
  };

  const changeTheme = (newThemeId) => {
    setCurrentThemeId(newThemeId);
    localStorage.setItem('bibi_theme', newThemeId);
    addToast('主題切換成功 🎨');
  };

  const openSettings = () => {
    setTempRole1(roleSettings.role1);
    setTempRole2(roleSettings.role2);
    setIsSettingsModalOpen(true);
  };
  
  const openUpcomingList = () => {
    triggerHaptic();
    setIsUpcomingModalOpen(true);
  };

  const handlePrevMonth = () => {
      triggerHaptic();
      setSlideDirection('slide-in-left');
      setAnimationKey(prev => prev + 1);
      setCurrentDate(new Date(year, month - 1, 1));
  };
  
  const handleNextMonth = () => {
      triggerHaptic();
      setSlideDirection('slide-in-right');
      setAnimationKey(prev => prev + 1);
      setCurrentDate(new Date(year, month + 1, 1));
  };
  
  const handleToday = () => {
      triggerHaptic();
      setSlideDirection(''); 
      setAnimationKey(prev => prev + 1);
      setCurrentDate(new Date());
  };

  const onTouchStart = (e) => { touchEndX.current = null; touchStartX.current = e.targetTouches[0].clientX; };
  const onTouchMove = (e) => { touchEndX.current = e.targetTouches[0].clientX; };
  const onTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;
    const distance = touchStartX.current - touchEndX.current;
    if (isEditModalOpen || isDayViewModalOpen || isSettingsModalOpen || isUpcomingModalOpen) return;
    if (distance > minSwipeDistance) handleNextMonth();
    if (distance < -minSwipeDistance) handlePrevMonth();
  };

  const getEventSegments = (dateStr) => {
    if (!dateStr) return [];
    const dayEvents = events.filter(ev => dateStr >= ev.startDate && dateStr <= ev.endDate);
    dayEvents.sort((a, b) => {
      const lenA = new Date(a.endDate).getTime() - new Date(a.startDate).getTime();
      const lenB = new Date(b.endDate).getTime() - new Date(b.startDate).getTime();
      if (lenA !== lenB) return lenB - lenA; 
      const timeA = a.startTime || '00:00';
      const timeB = b.startTime || '00:00';
      if (timeA !== timeB) return timeA.localeCompare(timeB);
      return a.id.localeCompare(b.id);
    });
    return dayEvents.map(ev => {
      const isStart = dateStr === ev.startDate;
      const isEnd = dateStr === ev.endDate;
      const dayOfWeek = new Date(dateStr).getDay();
      return { ...ev, isStart, isEnd, isSunday: dayOfWeek === 0, isSaturday: dayOfWeek === 6 };
    });
  };

  const handleDayClick = (dateStr) => { 
    triggerHaptic();
    setViewingDate(dateStr); 
    setIsDayViewModalOpen(true); 
  };
  
  const handleDayContextMenu = (e, dateStr) => {
    e.preventDefault(); 
    triggerHaptic();
    openEditModal(dateStr);
  };

  const openEditModal = (dateStr, event = null) => {
     triggerHaptic();
     setEditingId(event ? event.id : null);
     setFormTitle(event ? event.title : '');
     setFormDesc(event ? (event.description || '') : '');
     setFormStartDate(event ? event.startDate : dateStr);
     setFormEndDate(event ? event.endDate : dateStr);
     setFormIsAllDay(event ? event.isAllDay : true);
     setFormStartTime(event ? (event.startTime || '09:00') : '09:00');
     setFormEndTime(event ? (event.endTime || '10:00') : '10:00');
     
     const colorKey = event ? event.color : 'smokedPlum'; 
     setFormColor(colorKey);
     
     setFormEventType(event ? event.eventType : 'common');
     setIsDayViewModalOpen(false); 
     setIsEditModalOpen(true);
     setIsUpcomingModalOpen(false); 
  };

  const handleStartTimeChange = (e) => {
    const newStart = e.target.value;
    setFormStartTime(newStart);
    if (newStart) {
      const [h, m] = newStart.split(':').map(Number);
      const nextH = (h + 1) % 24;
      const newEnd = `${String(nextH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      setFormEndTime(newEnd);
    }
  };

  const saveEvent = async () => {
    triggerHaptic();
    const targetUid = customUserId || user?.uid;
    if (!targetUid) { addToast('尚未登入，請重新整理頁面', 'error'); return; }
    if (!formTitle.trim()) { addToast('請輸入行程標題', 'error'); return; }
    if (!formStartDate || !formEndDate) { addToast('請選擇開始與結束日期', 'error'); return; }

    setIsSaving(true);
    let start = formStartDate;
    let end = formEndDate;
    if (new Date(start) > new Date(end)) {
      [start, end] = [end, start];
      addToast('開始日晚於結束日，已自動互換', 'error');
    }

    const eventData = {
      title: formTitle, description: formDesc,
      startDate: start, endDate: end,
      isAllDay: formIsAllDay, startTime: formStartTime, endTime: formEndTime,
      color: formColor, eventType: formEventType
    };

    try {
      if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'users', targetUid, 'bibi_events', editingId), eventData);
      } else {
        await addDoc(collection(db, 'artifacts', appId, 'users', targetUid, 'bibi_events'), eventData);
      }
      
      setViewingDate(start);

      setIsEditModalOpen(false);
      setIsDayViewModalOpen(true);
      addToast(editingId ? '行程已更新 ✨' : '行程已建立 🎉');
    } catch (e) { 
        console.error("Save Error:", e); 
        addToast('發生錯誤，請重試', 'error');
    } finally {
        setIsSaving(false); 
    }
  };

  const deleteEvent = async () => {
    triggerHaptic();
    const targetUid = customUserId || user?.uid;
    if (!targetUid || !editingId) return;
    if (!window.confirm(`確定要刪除「${formTitle || '此行程'}」嗎？`)) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'users', targetUid, 'bibi_events', editingId));
      setIsEditModalOpen(false);
      if (viewingDate) setIsDayViewModalOpen(true);
      addToast('行程已刪除 🗑️');
    } catch (e) {
      console.error("Delete Error:", e);
      addToast('刪除失敗，請重試', 'error');
    }
  };

  if (loading) return <div className="h-dvh flex items-center justify-center" style={{ backgroundColor: theme.colors.bg }}><Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.colors.accent }} /></div>;
  
  const dayViewEvents = viewingDate ? events.filter(ev => viewingDate >= ev.startDate && viewingDate <= ev.endDate).sort((a,b) => (a.startTime||'00:00').localeCompare(b.startTime||'00:00')) : [];
  
  const todayStr = formatDate(new Date());
  
  const getDatesInRange = (startDate, endDate) => {
    const date = new Date(startDate);
    const end = new Date(endDate);
    const dates = [];
    while (date <= end) {
      dates.push(formatDate(new Date(date)));
      date.setDate(date.getDate() + 1);
    }
    return dates;
  };

  const activeEvents = events.filter(ev => ev.endDate >= todayStr);

  const groupedUpcomingRaw = activeEvents.reduce((acc, ev) => {
    const dates = getDatesInRange(ev.startDate, ev.endDate);
    dates.forEach(date => {
      if (date >= todayStr) { 
        if (!acc[date]) acc[date] = [];
        acc[date].push(ev);
      }
    });
    return acc;
  }, {});

  const sortedDates = Object.keys(groupedUpcomingRaw).sort();
  const groupedUpcoming = sortedDates.reduce((acc, date) => {
    acc[date] = groupedUpcomingRaw[date].sort((a, b) => {
         if (a.isAllDay && !b.isAllDay) return -1;
         if (!a.isAllDay && b.isAllDay) return 1;
         return (a.startTime || '00:00').localeCompare(b.startTime || '00:00');
    });
    return acc;
  }, {});

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const days = [];
  for (let i = firstDay - 1; i >= 0; i--) days.push({ day: null, fullDate: '' });
  for (let i = 1; i <= daysInMonth; i++) {
    const dStr = String(i).padStart(2, '0');
    const mStr = String(month + 1).padStart(2, '0');
    days.push({ day: i, fullDate: `${year}-${mStr}-${dStr}` });
  }
  const remainingCells = 42 - days.length;
  for (let i = 1; i <= remainingCells; i++) days.push({ day: null, fullDate: '' });

  return (
    <div className={`h-dvh flex flex-col ${currentFont.bodyClass}`} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} style={{ backgroundColor: theme.colors.bg, color: theme.colors.text }}>
      <HolidayAnimation type={holidayType} onDismiss={() => setHolidayType(null)} />
      <ToastContainer toasts={toasts} />
      
      <header className="flex-none flex items-center justify-between px-4 pb-3 pt-[calc(env(safe-area-inset-top)+12px)] z-10 transition-colors duration-300" style={{ backgroundColor: theme.colors.headerBg, borderBottom: `1px solid ${theme.colors.border}40` }}>
        <div className="flex items-center gap-3">
           <div onClick={openUpcomingList} className="cursor-pointer mr-1 active:opacity-70 transition-opacity">
             <img src="icon.png" className="w-8 h-8 object-contain" alt="Logo" />
           </div>
           <div onClick={handleToday} className="cursor-pointer active:opacity-70 transition-opacity">
             <h1 className="text-xl font-title font-bold tracking-tight text-2xl" style={{ color: theme.colors.text }}>BiBi❣</h1>
             <p className="text-[12px] font-title font-bold uppercase tracking-widest hidden sm:block" style={{ color: theme.colors.secondaryText }}>{year} . {month + 1}</p>
           </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-1.5 rounded-2xl border backdrop-blur-sm mr-2" style={{ backgroundColor: theme.colors.gridEmptyBg, borderColor: theme.colors.border + '20' }}>
            <button onClick={handlePrevMonth} className="p-2 rounded-xl transition-colors hover:opacity-70 active:scale-95" style={{ color: theme.colors.secondaryText }}><ChevronLeft className="w-5 h-5" /></button>
            <span className={`text-xl font-bold font-num-naikai min-w-[80px] text-center`} style={{ color: theme.colors.text }}>{month + 1}月 <span className="text-base" style={{ color: theme.colors.secondaryText }}>{year}</span></span>
            <button onClick={handleNextMonth} className="p-2 rounded-xl transition-colors hover:opacity-70 active:scale-95" style={{ color: theme.colors.secondaryText }}><ChevronRight className="w-5 h-5" /></button>
          </div>
          <button onClick={openSettings} className="p-2.5 rounded-xl shadow-sm border hover:brightness-95 transition-all active:scale-95" style={{ backgroundColor: theme.colors.modalBg, color: theme.colors.secondaryText, borderColor: theme.colors.border }}><Settings className="w-5 h-5" /></button>
        </div>
      </header>

      <div className="flex-none grid grid-cols-7" style={{ backgroundColor: theme.colors.gridHeaderBg, borderBottom: `1px solid ${theme.colors.border}40` }}>
        {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((d, i) => (
          <div key={i} className="py-2 text-center text-[12px] font-bold font-num-naikai tracking-widest" style={{ color: (i === 0 || i === 6) ? theme.colors.weekendText : theme.colors.weekdayText }}>{d}</div>
        ))}
      </div>

      <div key={animationKey} className={`flex-1 grid grid-cols-7 grid-rows-6 w-full h-full ${slideDirection}`}>
        {days.map((cell, idx) => {
          const hasDate = cell.day !== null;
          const segments = hasDate ? getEventSegments(cell.fullDate) : [];
          const isToday = hasDate && cell.fullDate === formatDate(new Date());
          const holidayInfo = hasDate ? holidayData[year]?.[cell.fullDate] : null;
          const isHoliday = holidayInfo?.isHoliday === true;
          const dayOfWeek = idx % 7;
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
          
          let cellBg = theme.colors.gridBg;
          if (!hasDate) cellBg = theme.colors.gridEmptyBg;
          else if (isHoliday || isWeekend) cellBg = theme.colors.gridWeekendBg;
          
          const dateTextColor = (isHoliday || dayOfWeek === 0) ? theme.colors.weekendText : theme.colors.text;

          return (
            <div 
              key={idx} 
              onClick={() => hasDate && handleDayClick(cell.fullDate)} 
              onContextMenu={(e) => hasDate && handleDayContextMenu(e, cell.fullDate)}
              className="relative border-b border-r flex flex-col active:brightness-95 transition-colors cursor-pointer select-none" 
              style={{ backgroundColor: cellBg, borderColor: theme.colors.border + '20' }}
            >
              {hasDate && (
                <div className="flex flex-col items-center pt-1 mb-0.5 px-0 min-h-[38px] justify-start">
                   <span 
                     className={`text-lg sm:text-xl font-bold font-num-naikai h-7 w-7 flex items-center justify-center rounded-full transition-all ${isToday ? 'shadow-md' : ''}`}
                     style={{ backgroundColor: isToday ? theme.colors.accent : 'transparent', color: isToday ? '#fff' : dateTextColor }}
                   >
                     {cell.day}
                   </span>
                   {(isHoliday) && (
                     <span className="text-[10px] text-[#9F1239] font-medium -mt-1 truncate max-w-full px-1 leading-tight flex items-center justify-center" style={{ color: theme.colors.weekendText }}>
                       {holidayInfo.name}
                     </span>
                   )}
                </div>
              )}
              <div className="flex-1 flex flex-col gap-[2px] w-full pb-1 px-0">
                {segments.slice(0, 4).map((ev) => {
                  const roundLeft = ev.isStart || ev.isSunday;
                  const roundRight = ev.isEnd || ev.isSaturday;
                  const colorObj = TECHO_COLORS[ev.color] || TECHO_COLORS.latte;
                  
                  let marginClass = '';
                  if (!roundLeft) marginClass += ' -ml-[1px] rounded-l-none'; else marginClass += ' ml-1 rounded-l-md';
                  if (!roundRight) marginClass += ' -mr-[1px] rounded-r-none'; else marginClass += ' mr-1 rounded-r-md';

                  return (
                    <div 
                        key={ev.id} 
                        onClick={(e) => { e.stopPropagation(); openEditModal(null, ev); }} 
                        className={`text-[10px] font-bold font-num-naikai sm:text-xs h-[18px] sm:h-[20px] flex items-center px-1 transition-all hover:brightness-95 active:scale-95 relative z-10 ${marginClass}`}
                        style={{ backgroundColor: colorObj.hex, color: colorObj.text }}
                    >
                      <span className="truncate w-full font-medium leading-none flex items-center gap-1">
                        {ev.isStart && !ev.isAllDay && ev.startTime && (
                          <span className="text-[10px] font-bold font-num-naikai mr-1">{ev.startTime}</span>
                        )}
                        {ev.title}
                      </span>
                    </div>
                  );
                })}
                {segments.length > 4 && (
                  <div
                    className="text-[10px] font-num-naikai text-center leading-none mt-auto font-bold mx-1 py-0.5 rounded transition-colors"
                    style={{ color: theme.colors.weekdayText, backgroundColor: theme.colors.gridHeaderBg }}
                  >
                    +{segments.length - 4} 個
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Settings Modal - Floating Centered */}
      {isSettingsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-[2px] p-4" style={{ backgroundColor: theme.colors.text + '30' }}>
           <div className="w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border flex flex-col max-h-[80vh] modal-enter" style={{ backgroundColor: theme.colors.modalBg, borderColor: theme.colors.border }}>
              <div className="px-5 py-4 border-b flex justify-between items-center shrink-0 flex-none" style={{ backgroundColor: theme.colors.modalHeaderBg, borderColor: theme.colors.border }}>
                 <h3 className="font-bold flex items-center gap-2" style={{ color: theme.colors.text }}><Settings className="w-5 h-5"/> 設定 & 同步</h3>
                 <button onClick={() => setIsSettingsModalOpen(false)} className="p-1 rounded-full hover:opacity-70 active:scale-95" style={{ color: theme.colors.secondaryText }}><X className="w-5 h-5" /></button>
              </div>
              
              <div className="p-6 space-y-5 overflow-y-auto flex-1">
                {/* Theme Switcher */}
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase flex items-center gap-1" style={{ color: theme.colors.secondaryText }}><Palette className="w-3 h-3"/> 主題風格</label>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.values(THEMES).map(t => (
                      <button 
                        key={t.id} 
                        onClick={() => changeTheme(t.id)}
                        className={`p-2 rounded-xl border flex flex-col items-center gap-1 transition-all active:scale-95 ${currentThemeId === t.id ? 'ring-2 ring-offset-1' : 'hover:scale-105'}`}
                        style={{
                          backgroundColor: t.colors.bg,
                          borderColor: t.colors.border,
                          '--tw-ring-color': theme.colors.accent
                        }}
                      >
                        <div className="w-6 h-6 rounded-full border shadow-sm" style={{ backgroundColor: t.colors.accent }}></div>
                        <span className="text-[10px] font-bold" style={{ color: t.colors.text }}>{t.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <hr style={{ borderColor: theme.colors.border }} />

                {/* Install PWA Button (Android/Chrome) */}
                {deferredPrompt && (
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase flex items-center gap-1" style={{ color: theme.colors.secondaryText }}><Download className="w-3 h-3"/> 安裝應用程式</label>
                    <button onClick={handleInstallApp} className="w-full py-2.5 text-xs font-bold text-white rounded-lg shadow-sm transition-transform active:scale-95 hover:opacity-90 flex items-center justify-center gap-2" style={{ backgroundColor: theme.colors.accent }}>
                      <Download className="w-4 h-4" /> 安裝到主畫面
                    </button>
                    <hr style={{ borderColor: theme.colors.border }} />
                  </div>
                )}

                {/* ID Sync Section */}
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase" style={{ color: theme.colors.secondaryText }}>裝置識別碼 (ID)</label>
                  <div className="flex gap-2 items-center border p-2 rounded-lg" style={{ backgroundColor: theme.colors.gridHeaderBg, borderColor: theme.colors.border }}>
                    <code className="text-[10px] break-all flex-1" style={{ color: theme.colors.text }}>{user?.uid || 'Loading...'}</code>
                    <button onClick={handleCopyId} className="p-1 rounded hover:bg-white active:scale-90 transition-transform" style={{ color: theme.colors.accent }}><Copy className="w-4 h-4" /></button>
                  </div>
                  <div className="pt-2">
                    <input 
                      type="text" 
                      value={customUserId} 
                      onChange={(e) => setCustomUserId(e.target.value)}
                      placeholder="手動輸入 ID 以同步資料..."
                      className="w-full text-sm border rounded-lg p-2 focus:ring-1 outline-none"
                      style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.inputBg, color: theme.colors.text }}
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={handleResetUid} className="flex-1 py-2 text-xs font-bold rounded-lg active:scale-95 transition-transform" style={{ backgroundColor: theme.colors.gridHeaderBg, color: theme.colors.secondaryText }}>重置</button>
                    <button onClick={handleSaveCustomUid} className="flex-1 py-2 text-xs font-bold text-white rounded-lg shadow-sm active:scale-95 transition-transform" style={{ backgroundColor: theme.colors.accent }}>切換帳號</button>
                  </div>
                </div>

                <hr style={{ borderColor: theme.colors.border }} />

                {/* LINE 通知綁定 Section */}
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase flex items-center gap-1" style={{ color: theme.colors.secondaryText }}>
                    💬 LINE 通知
                  </label>
                  <p className="text-[11px] leading-snug" style={{ color: theme.colors.secondaryText }}>
                    1. 加 BiBi Schedule Bot 為好友<br/>
                    2. 點下方按鈕複製綁定指令<br/>
                    3. 在 LINE 對 Bot 貼上並送出
                  </p>
                  <button
                    onClick={() => {
                      const targetUid = customUserId || user?.uid || '';
                      if (!targetUid) { addToast('尚未登入，請重新整理頁面', 'error'); return; }
                      const cmd = `綁定 ${targetUid}`;
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(cmd).then(
                          () => addToast('已複製，貼到 LINE Bot 對話即可 ✨'),
                          () => addToast('複製失敗，請手動複製 ID', 'error')
                        );
                      } else {
                        try {
                          const ta = document.createElement('textarea');
                          ta.value = cmd;
                          document.body.appendChild(ta);
                          ta.select();
                          document.execCommand('copy');
                          document.body.removeChild(ta);
                          addToast('已複製，貼到 LINE Bot 對話即可 ✨');
                        } catch (e) {
                          addToast('複製失敗，請手動複製 ID', 'error');
                        }
                      }
                    }}
                    className="w-full py-2 text-xs font-bold rounded-lg active:scale-95 transition-transform text-white shadow-sm"
                    style={{ backgroundColor: theme.colors.accent }}
                  >
                    複製「綁定」指令
                  </button>
                  <p className="text-[10px] leading-snug opacity-70" style={{ color: theme.colors.secondaryText }}>
                    取消通知請在 LINE 對 Bot 傳：解除綁定
                  </p>
                </div>

                <hr style={{ borderColor: theme.colors.border }} />

                {/* Role Names Section */}
                <div className="space-y-3">
                  <label className="text-xs font-bold uppercase flex items-center gap-1" style={{ color: theme.colors.secondaryText }}><Users className="w-3 h-3"/> 角色名稱設定</label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                       <span className="text-[10px] font-bold" style={{ color: theme.colors.text }}>角色 A (我)</span>
                       <input type="text" value={tempRole1} onChange={(e) => setTempRole1(e.target.value)} className="w-full text-sm border rounded-lg p-2 outline-none text-center" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.inputBg, color: theme.colors.text }} />
                    </div>
                    <div className="space-y-1">
                       <span className="text-[10px] font-bold" style={{ color: theme.colors.text }}>角色 B (夥伴)</span>
                       <input type="text" value={tempRole2} onChange={(e) => setTempRole2(e.target.value)} className="w-full text-sm border rounded-lg p-2 outline-none text-center" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.inputBg, color: theme.colors.text }} />
                    </div>
                  </div>
                  <button onClick={handleSaveRoles} className="w-full py-2.5 text-xs font-bold text-white rounded-lg shadow-sm transition-transform active:scale-95 hover:opacity-90" style={{ backgroundColor: theme.colors.secondaryText }}>儲存名稱設定</button>
                </div>
              </div>
           </div>
        </div>
      )}

      {/* Day View Modal - Floating Centered */}
      {isDayViewModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-[2px] p-4" style={{ backgroundColor: theme.colors.text + '30' }}>
           <div className="w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border flex flex-col max-h-[80vh] modal-enter" style={{ backgroundColor: theme.colors.modalBg, borderColor: theme.colors.border }}>
              <div className="px-5 py-4 border-b flex justify-between items-center shrink-0 flex-none" style={{ backgroundColor: theme.colors.modalHeaderBg, borderColor: theme.colors.border }}>
                 <div className="flex items-baseline gap-2">
                   <span className={`text-2xl font-bold font-num-naikai`} style={{ color: theme.colors.text }}>{viewingDate}</span>
                   <span className="text-xs font-bold uppercase" style={{ color: theme.colors.secondaryText }}>
                    {viewingDate && !isNaN(new Date(viewingDate).getTime()) 
                       ? new Date(viewingDate + 'T00:00:00').toLocaleDateString('zh-TW', { weekday: 'long' }) 
                       : ''}
                   </span>
                 </div>
                 <button onClick={() => setIsDayViewModalOpen(false)} className="p-1.5 rounded-full transition-colors hover:opacity-70 active:scale-95" style={{ color: theme.colors.secondaryText }}><X className="w-5 h-5" /></button>
              </div>
              <div className="p-4 overflow-y-auto flex-1 space-y-3" style={{ backgroundColor: theme.colors.modalHeaderBg }}>
                 {dayViewEvents.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 opacity-50" style={{ color: theme.colors.secondaryText }}>
                       <Coffee className="w-10 h-10 mb-2" /><p className="font-hand text-lg">今天沒有行程，享受生活吧！</p>
                    </div>
                 ) : (
                    dayViewEvents.map(ev => {
                       const colorObj = TECHO_COLORS[ev.color] || TECHO_COLORS.latte;
                       let ownerLabel = '';
                       if (ev.eventType === 'me') ownerLabel = roleSettings.role1;
                       else if (ev.eventType === 'partner') ownerLabel = roleSettings.role2;
                       else ownerLabel = '共同';

                       return (
                         <div key={ev.id} onClick={() => openEditModal(null, ev)} className="p-3 rounded-xl border shadow-sm flex items-start gap-3 cursor-pointer hover:shadow-md transition-shadow active:scale-[0.98]" style={{ backgroundColor: theme.colors.inputBg, borderColor: theme.colors.border }}>
                            <div className="w-3 h-3 rounded-full shrink-0 mt-1.5" style={{ backgroundColor: colorObj.hex }}></div>
                            <div className="flex-1 min-w-0">
                               <div className="flex justify-between items-start">
                                  <h4 className="font-bold truncate" style={{ color: theme.colors.text }}>{ev.title}</h4>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded ml-2 whitespace-nowrap" style={{ backgroundColor: theme.colors.gridHeaderBg, color: theme.colors.secondaryText }}>{ownerLabel}</span>
                               </div>
                               <div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.secondaryText }}>{ev.isAllDay ? <span className="px-1.5 rounded" style={{ backgroundColor: theme.colors.inputBorder, color: theme.colors.text }}>全天</span> : <span className="font-bold font-num-naikai text-sm">{ev.startTime} - {ev.endTime}</span>}</div>
                               {ev.description && (
                                 <p className="mt-1.5 text-xs whitespace-pre-wrap break-words leading-snug" style={{ color: theme.colors.secondaryText }}>{ev.description}</p>
                               )}
                            </div>
                            <Edit className="w-4 h-4 mt-1 shrink-0" style={{ color: theme.colors.secondaryText }} />
                         </div>
                       )
                    })
                 )}
              </div>
              <div className="p-4 border-t shrink-0 flex-none" style={{ backgroundColor: theme.colors.modalBg, borderColor: theme.colors.border }}>
                 <button onClick={() => openEditModal(viewingDate)} className="w-full text-white py-3 rounded-xl shadow-md font-bold flex items-center justify-center gap-2 transition-transform active:scale-95 hover:opacity-90" style={{ backgroundColor: theme.colors.accent }}><Plus className="w-5 h-5" /> 新增行程</button>
              </div>
           </div>
        </div>
      )}

      {/* Edit Modal - Floating Centered */}
      {isEditModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-[2px] p-4" style={{ backgroundColor: theme.colors.text + '30' }}>
          <div className="w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border flex flex-col max-h-[90vh] modal-enter" style={{ backgroundColor: theme.colors.modalBg, borderColor: theme.colors.border }}>
            <div className="px-5 py-4 border-b flex justify-between items-center shrink-0 flex-none" style={{ backgroundColor: theme.colors.modalHeaderBg, borderColor: theme.colors.border }}>
               <h3 className="font-bold flex items-center gap-2" style={{ color: theme.colors.text }}><Leaf className="w-4 h-4" style={{ color: theme.colors.accent }} /> {editingId ? '編輯行程' : '建立行程'}</h3>
               <div className="flex gap-2">
                 {editingId && <button onClick={deleteEvent} className="p-1.5 hover:opacity-70 rounded-full transition-colors active:scale-95" style={{ color: theme.colors.secondaryText }}><Trash2 className="w-4 h-4" /></button>}
                 <button onClick={() => setIsEditModalOpen(false)} className="p-1.5 hover:opacity-70 rounded-full transition-colors active:scale-95" style={{ color: theme.colors.secondaryText }}><X className="w-4 h-4" /></button>
               </div>
            </div>
            <div className="p-6 space-y-5 overflow-y-auto flex-1">
              <div className="flex gap-2 p-1 rounded-xl" style={{ backgroundColor: theme.colors.gridHeaderBg }}>
                 {['me', 'partner', 'common'].map(type => (
                    <button key={type} onClick={() => { setFormEventType(type); if(type === 'me') setFormColor('tea'); if(type === 'partner') setFormColor('sesame'); if(type === 'common') setFormColor('latte'); }} className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all ${formEventType === type ? 'shadow' : 'opacity-60'}`} style={{ backgroundColor: formEventType === type ? theme.colors.modalBg : 'transparent', color: formEventType === type ? theme.colors.text : theme.colors.secondaryText }}>
                      {type === 'me' ? roleSettings.role1 : type === 'partner' ? roleSettings.role2 : '共同'}
                    </button>
                 ))}
              </div>
              <input type="text" value={formTitle} onChange={(e) => setFormTitle(e.target.value)} placeholder="行程標題..." className="w-full text-xl font-bold border-b-2 bg-transparent py-1 transition-colors outline-none" style={{ color: theme.colors.text, borderColor: theme.colors.border, '--tw-ring-color': theme.colors.accent }} autoFocus />
              <div className="space-y-3 p-3 rounded-xl border" style={{ backgroundColor: theme.colors.modalHeaderBg, borderColor: theme.colors.border }}>
                 <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-bold text-sm" style={{ color: theme.colors.text }}><Clock className="w-4 h-4" style={{ color: theme.colors.accent }} /> 時間</div>
                    <label className="flex items-center gap-2 text-xs font-bold cursor-pointer" style={{ color: theme.colors.secondaryText }}><input type="checkbox" checked={formIsAllDay} onChange={e => setFormIsAllDay(e.target.checked)} className="accent-current" style={{ color: theme.colors.accent }} /> 全天</label>
                 </div>
                 <div className="grid grid-cols-[auto_1fr] gap-2 items-center text-sm">
                    <span className="text-xs font-bold" style={{ color: theme.colors.secondaryText }}>開始</span>
                    <div className="flex gap-2">
                       <input type="date" value={formStartDate} onChange={e => setFormStartDate(e.target.value)} className="border rounded px-2 py-1 w-full text-lg font-bold font-num-naikai" style={{ backgroundColor: theme.colors.inputBg, borderColor: theme.colors.inputBorder, color: theme.colors.text }} />
                       {!formIsAllDay && <input type="time" value={formStartTime} onChange={handleStartTimeChange} className="border rounded px-1 py-1 text-lg font-bold font-num-naikai" style={{ backgroundColor: theme.colors.inputBg, borderColor: theme.colors.inputBorder, color: theme.colors.text }} />}
                    </div>
                    <span className="text-xs font-bold" style={{ color: theme.colors.secondaryText }}>結束</span>
                    <div className="flex gap-2">
                       <input type="date" value={formEndDate} onChange={e => setFormEndDate(e.target.value)} className="border rounded px-2 py-1 w-full text-lg font-bold font-num-naikai" style={{ backgroundColor: theme.colors.inputBg, borderColor: theme.colors.inputBorder, color: theme.colors.text }} />
                       {!formIsAllDay && <input type="time" value={formEndTime} onChange={e => setFormEndTime(e.target.value)} className="border rounded px-1 py-1 text-lg font-bold font-num-naikai" style={{ backgroundColor: theme.colors.inputBg, borderColor: theme.colors.inputBorder, color: theme.colors.text }} />}
                    </div>
                 </div>
              </div>
              <div className="flex gap-3">
                 <AlignLeft className="w-4 h-4 mt-1 shrink-0" style={{ color: theme.colors.accent }} />
                 <textarea placeholder="備註說明..." value={formDesc} onChange={e => setFormDesc(e.target.value)} className="w-full rounded-xl p-3 text-sm h-20 outline-none border resize-none" style={{ backgroundColor: theme.colors.modalHeaderBg, color: theme.colors.text, borderColor: theme.colors.border }} />
              </div>
              
              {/* Fixed Color Picker */}
              <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar items-center">
                {Object.entries(TECHO_COLORS).map(([key, style]) => (
                  <button key={key} onClick={() => setFormColor(key)} className={`w-8 h-8 rounded-full shrink-0 transition-transform flex items-center justify-center ${formColor === key ? 'ring-2 ring-offset-2 scale-110' : 'hover:scale-105 opacity-80 hover:opacity-100'}`} style={{ backgroundColor: style.hex, '--tw-ring-color': theme.colors.secondaryText }}>
                    {formColor === key && <CheckSquare className="w-4 h-4 drop-shadow-md" style={{ color: style.text }} />}
                  </button>
                ))}
              </div>
            </div>
            <div className="px-5 py-4 border-t flex justify-end shrink-0" style={{ backgroundColor: theme.colors.modalHeaderBg, borderColor: theme.colors.border }}>
              <button onClick={saveEvent} disabled={isSaving} className="text-white text-sm font-bold py-2.5 px-6 rounded-xl shadow-md transition-transform active:scale-95 flex items-center gap-2 disabled:opacity-50" style={{ backgroundColor: theme.colors.accent }}>
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin"/> : <Save className="w-4 h-4" />} 
                {isSaving ? '儲存中...' : '儲存行程'}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* [NEW] Upcoming Events Modal (Floating Centered) */}
      {isUpcomingModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-[2px] p-4" style={{ backgroundColor: theme.colors.text + '30' }}>
           <div className="w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border flex flex-col max-h-[80vh] modal-enter" style={{ backgroundColor: theme.colors.modalBg, borderColor: theme.colors.border }}>
              <div className="px-5 py-4 border-b flex justify-between items-center shrink-0 flex-none" style={{ backgroundColor: theme.colors.modalHeaderBg, borderColor: theme.colors.border }}>
                 <h3 className="font-bold flex items-center gap-2" style={{ color: theme.colors.text }}>
                   <List className="w-5 h-5" style={{ color: theme.colors.accent }} /> 接下來的行程
                 </h3>
                 <button onClick={() => setIsUpcomingModalOpen(false)} className="p-1.5 rounded-full transition-colors hover:opacity-70 active:scale-95" style={{ color: theme.colors.secondaryText }}><X className="w-5 h-5" /></button>
              </div>
              
              <div className="p-4 overflow-y-auto flex-1 space-y-4" style={{ backgroundColor: theme.colors.modalHeaderBg }}>
                 {Object.keys(groupedUpcoming).length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 opacity-50" style={{ color: theme.colors.secondaryText }}>
                       <Coffee className="w-10 h-10 mb-2" /><p className="font-hand text-lg">目前沒有待辦事項，好好休息！</p>
                    </div>
                 ) : (
                    Object.entries(groupedUpcoming).map(([date, events]) => (
                      <div key={date} className="space-y-2">
                         <div className="sticky top-0 z-10 py-1 px-2 text-xs font-bold uppercase rounded-md shadow-sm" style={{ backgroundColor: theme.colors.accent, color: '#FFF' }}>
                           {date} ({new Date(date + 'T00:00:00').toLocaleDateString('zh-TW', { weekday: 'short' })})
                         </div>
                         {events.map(ev => {
                            const colorObj = TECHO_COLORS[ev.color] || TECHO_COLORS.latte;
                            let ownerLabel = '';
                            if (ev.eventType === 'me') ownerLabel = roleSettings.role1;
                            else if (ev.eventType === 'partner') ownerLabel = roleSettings.role2;
                            else ownerLabel = '共同';

                            return (
                              <div key={ev.id} onClick={() => openEditModal(null, ev)} className="p-3 rounded-xl border shadow-sm flex items-center gap-3 cursor-pointer hover:shadow-md transition-shadow active:scale-[0.98]" style={{ backgroundColor: theme.colors.inputBg, borderColor: theme.colors.border }}>
                                 <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: colorObj.hex }}></div>
                                 <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-start">
                                       <h4 className="font-bold truncate" style={{ color: theme.colors.text }}>{ev.title}</h4>
                                       <span className="text-[10px] px-1.5 py-0.5 rounded ml-2 whitespace-nowrap" style={{ backgroundColor: theme.colors.gridHeaderBg, color: theme.colors.secondaryText }}>{ownerLabel}</span>
                                    </div>
                                    <div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.secondaryText }}>
                                      {ev.isAllDay ? <span className="px-1.5 rounded" style={{ backgroundColor: theme.colors.inputBorder, color: theme.colors.text }}>全天</span> : <span className="font-bold font-num-naikai text-sm">{ev.startTime} - {ev.endTime}</span>}
                                    </div>
                                 </div>
                                 <Edit className="w-4 h-4" style={{ color: theme.colors.secondaryText }} />
                              </div>
                            )
                         })}
                      </div>
                    ))
                 )}
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export { App, ErrorBoundary };
