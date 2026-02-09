// ===============================
‏// 1. REQUIREMENTS AND CONFIGURATION
// ===============================
const axios = require('axios');
const WebSocket = require('ws');
require('dotenv').config();

// ===============================
// 2. TELEGRAM SENDER
// ===============================
class TelegramSender {
    constructor() {
        this.sentHashes = new Map();
        this.cooldown = new Map();
        this.token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
    }

    async sendTelegram(text, symbol, signalHash) {
        // التحقق من التبريد
        if (this.cooldown.has(symbol)) {
            const cooldownUntil = this.cooldown.get(symbol);
            if (Date.now() < cooldownUntil) {
                console.log(`⏳ Cooldown for ${symbol}, skipping...`);
                return false;
            }
        }

        // التحقق من التكرار
        if (this.sentHashes.has(signalHash)) {
            console.log(`♻️ Duplicate signal for ${symbol}, skipping...`);
            return false;
        }

        // Retry logic
        let retries = 3;
        while (retries > 0) {
            try {
                const response = await axios.post(
                    `https://api.telegram.org/bot${this.token}/sendMessage`,
                    {
                        chat_id: this.chatId,
                        text: text,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    },
                    { timeout: 5000 }
                );

                if (response.data.ok) {
                    this.sentHashes.set(signalHash, Date.now());
                    this.cooldown.set(symbol, Date.now() + 30 * 60 * 1000);
                    
                    this.cleanOldHashes();
                    
                    console.log(`✅ Telegram sent for ${symbol}`);
                    return true;
                }
            } catch (error) {
                console.error(`❌ Telegram error (${retries} retries left):`, error.message);
                retries--;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        return false;
    }

    cleanOldHashes() {
        const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
        for (const [hash, timestamp] of this.sentHashes.entries()) {
            if (timestamp < fourHoursAgo) {
                this.sentHashes.delete(hash);
            }
        }
    }
}

// ===============================
// 3. SYMBOL STORE
// ===============================
class SymbolStore {
    constructor(symbolInfo) {
        this.symbol = symbolInfo.symbol;
        this.name = symbolInfo.display_name;
        this.market = symbolInfo.market;
        this.pip = symbolInfo.pip;
        
        this.candles = [];
        this.lastCandle = null;
        this.currentCandle = null;
        
        this.state = 'WAIT';
        this.analysis = null;
        
        this.cooldownUntil = 0;
        this.lastSignalHash = '';
        this.lastSignalTime = 0;
        
        this.lastAnalysisTime = 0;
        this.ticksCount = 0;
        
        // سيتم تحديثها باستمرار
        this.isActiveSessionTime = false;
        this.hasHighImpactNews = false;
    }

    updateCandle(tick) {
        const tickTime = tick.epoch * 1000;
        const candleStart = Math.floor(tickTime / 60000) * 60000;
        
        if (!this.currentCandle || this.currentCandle.start !== candleStart) {
            if (this.currentCandle) {
                this.candles.push({ ...this.currentCandle });
                
                if (this.candles.length > 200) {
                    this.candles.shift();
                }
                
                this.lastCandle = { ...this.currentCandle };
            }
            
            this.currentCandle = {
                start: candleStart,
                open: tick.quote,
                high: tick.quote,
                low: tick.quote,
                close: tick.quote,
                volume: 1
            };
            
            return true;
        } else {
            this.currentCandle.high = Math.max(this.currentCandle.high, tick.quote);
            this.currentCandle.low = Math.min(this.currentCandle.low, tick.quote);
            this.currentCandle.close = tick.quote;
            this.currentCandle.volume++;
            
            return false;
        }
    }
}

// ===============================
// 4. TECHNICAL ANALYSIS UTILS (مع تصحيح RSI)
// ===============================
class TechnicalAnalysis {
    static calculateRSI(candles, period = 14) {
        if (candles.length < period + 1) return 50;
        
        let gains = 0;
        let losses = 0;
        
        // استخدام period + 1 شمعة للتحقق من التغيرات
        const startIndex = Math.max(0, candles.length - (period + 1));
        const relevantCandles = candles.slice(startIndex);
        
        for (let i = 1; i < relevantCandles.length; i++) {
            const change = relevantCandles[i].close - relevantCandles[i-1].close;
            if (change > 0) {
                gains += change;
            } else {
                losses -= change;
            }
        }
        
        const avgGain = gains / period;
        const avgLoss = losses / period;
        
        if (avgLoss === 0) return 100;
        if (avgGain === 0) return 0;
        
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    static calculateSMA(candles) {
        if (candles.length === 0) return 0;
        const sum = candles.reduce((acc, c) => acc + c.close, 0);
        return sum / candles.length;
    }

    static calculateEMA(candles, period) {
        if (candles.length < period) return this.calculateSMA(candles);
        
        let ema = this.calculateSMA(candles.slice(0, period));
        const multiplier = 2 / (period + 1);
        
        for (let i = period; i < candles.length; i++) {
            ema = (candles[i].close - ema) * multiplier + ema;
        }
        
        return ema;
    }

    static calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return 0;
        
        let trueRanges = [];
        const startIdx = Math.max(1, candles.length - period - 1);
        
        for (let i = startIdx; i < candles.length; i++) {
            const high = candles[i].high;
            const low = candles[i].low;
            const prevClose = candles[i-1].close;
            
            const tr1 = high - low;
            const tr2 = Math.abs(high - prevClose);
            const tr3 = Math.abs(low - prevClose);
            
            trueRanges.push(Math.max(tr1, tr2, tr3));
        }
        
        return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
    }

    static calculateBollingerBands(candles, period = 20, stdDev = 2) {
        if (candles.length < period) return { upper: 0, middle: 0, lower: 0 };
        
        const slice = candles.slice(-period);
        const closes = slice.map(c => c.close);
        const middle = this.calculateSMA(slice);
        
        const variance = closes.reduce((acc, price) => 
            acc + Math.pow(price - middle, 2), 0) / period;
        const std = Math.sqrt(variance);
        
        return {
            upper: middle + (std * stdDev),
            middle,
            lower: middle - (std * stdDev)
        };
    }

    static calculateMACD(candles) {
        if (candles.length < 26) return { macd: 0, signal: 0, histogram: 0 };
        
        const ema12 = this.calculateEMA(candles, 12);
        const ema26 = this.calculateEMA(candles, 26);
        const macd = ema12 - ema26;
        
        // لحساب الإشارة نحتاج قيم MACD تاريخية
        const macdValues = [];
        const macdCandles = [];
        
        for (let i = 0; i < 9; i++) {
            const start = Math.max(0, candles.length - 26 - i);
            const slice = candles.slice(start, candles.length - i);
            
            if (slice.length >= 26) {
                const currentMACD = this.calculateEMA(slice, 12) - 
                                   this.calculateEMA(slice, 26);
                macdValues.push(currentMACD);
                macdCandles.push({ close: currentMACD });
            }
        }
        
        const signal = macdCandles.length >= 9 ? 
            this.calculateEMA(macdCandles, 9) : macd;
        
        return {
            macd,
            signal,
            histogram: macd - signal
        };
    }
}

// ===============================
// 5. PRODUCTION DERIV WEBSOCKET (مع تصحيحات Memory Leak)
// ===============================
class ProductionDerivWebSocket {
    constructor(appId) {
        this.appId = appId;
        this.ws = null;
        this.connected = false;
        this.reconnectDelay = 1000;
        this.maxReconnectDelay = 30000;
        this.subscriptions = new Map();
        this.pendingRequests = new Map();
        this.subscriptionIds = new Map();
        this.subscriptionQueue = [];
        this.processingQueue = false;
        this.batchSize = 5;
        this.batchDelay = 500;
        this.pingInterval = null;
        
        // Session times (UTC)
        this.sessions = {
            london: { start: 7, end: 16 },
            newyork: { start: 13, end: 22 }
        };
        
        this.newsEvents = new Map();
    }

    connect() {
        this.ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`);
        
        this.ws.on('open', () => {
            console.log('✅ Deriv WebSocket Connected');
            this.connected = true;
            this.reconnectDelay = 1000;
            
            this.pingInterval = setInterval(() => {
                if (this.connected) {
                    this.ws.send(JSON.stringify({ ping: 1 }));
                }
            }, 30000);
            
            this.processSubscriptionQueue();
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                
                if (message.msg_type === 'ping') {
                    this.ws.send(JSON.stringify({ pong: 1 }));
                    return;
                }
                
                if (message.echo_req?.req_id) {
                    const callback = this.pendingRequests.get(message.echo_req.req_id);
                    if (callback) {
                        callback(message);
                        this.pendingRequests.delete(message.echo_req.req_id);
                    }
                    return;
                }
                
                if (message.msg_type === 'tick' && message.tick) {
                    if (this.onTick) {
                        this.onTick(message.tick);
                    }
                    
                    if (message.subscription?.id) {
                        this.subscriptionIds.set(message.tick.symbol, message.subscription.id);
                    }
                    return;
                }
                
                if (message.error) {
                    console.error('WebSocket Error:', message.error);
                }
                
            } catch (error) {
                console.error('❌ Error parsing WebSocket message:', error);
            }
        });

        this.ws.on('close', () => this.handleDisconnect());
        this.ws.on('error', (error) => console.error('WebSocket Error:', error));
    }

    handleDisconnect() {
        console.log('❌ WebSocket Disconnected');
        this.connected = false;
        this.subscriptionIds.clear();
        this.pendingRequests.clear();
        
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        
        this.reconnect();
    }

    reconnect() {
        setTimeout(() => {
            console.log(`🔄 Reconnecting in ${this.reconnectDelay}ms...`);
            this.connect();
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        }, this.reconnectDelay);
    }

    sendRequest(request, callback) {
        if (!this.connected) {
            console.error('❌ WebSocket not connected');
            if (callback) callback({ error: { code: 'NOT_CONNECTED' } });
            return null;
        }

        const reqId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        request.req_id = reqId;
        
        this.pendingRequests.set(reqId, callback);
        
        // Timeout لمنع تراكم الطلبات المعلقة
        setTimeout(() => {
            if (this.pendingRequests.has(reqId)) {
                this.pendingRequests.delete(reqId);
                if (callback) {
                    callback({ error: { code: 'TIMEOUT', message: 'Request timeout' } });
                }
            }
        }, 15000);
        
        this.ws.send(JSON.stringify(request));
        
        return reqId;
    }

    subscribeTicks(symbol) {
        if (this.subscriptionIds.has(symbol)) {
            return true;
        }

        this.subscriptionQueue.push(symbol);
        
        if (!this.processingQueue) {
            this.processSubscriptionQueue();
        }
        
        return true;
    }

    async processSubscriptionQueue() {
        if (this.processingQueue || !this.connected || this.subscriptionQueue.length === 0) {
            return;
        }

        this.processingQueue = true;
        
        while (this.subscriptionQueue.length > 0) {
            const batch = this.subscriptionQueue.splice(0, this.batchSize);
            
            await Promise.all(batch.map(symbol => 
                new Promise(resolve => {
                    setTimeout(() => {
                        this.sendRequest({
                            ticks: symbol,
                            subscribe: 1
                        }, (response) => {
                            if (!response.error && response.subscription) {
                                this.subscriptionIds.set(symbol, response.subscription.id);
                                console.log(`📡 Subscribed to ${symbol}`);
                            } else if (response.error) {
                                console.error(`❌ Failed to subscribe to ${symbol}:`, response.error.message);
                            }
                            resolve();
                        });
                    }, Math.random() * 100);
                })
            ));
            
            if (this.subscriptionQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, this.batchDelay));
            }
        }
        
        this.processingQueue = false;
    }

    unsubscribeTicks(symbol) {
        const subscriptionId = this.subscriptionIds.get(symbol);
        if (!subscriptionId || !this.connected) return false;

        this.sendRequest({
            forget: subscriptionId
        }, (response) => {
            if (!response.error) {
                this.subscriptionIds.delete(symbol);
                console.log(`🔕 Unsubscribed from ${symbol}`);
            }
        });
        
        return true;
    }

    requestHistory(symbol, granularity = 60, count = 200) {
        return new Promise((resolve) => {
            this.sendRequest({
                ticks_history: symbol,
                adjust_start_time: 1,
                count,
                granularity,
                style: "candles",
                end: "latest"
            }, (response) => {
                resolve(response.candles || []);
            });
        });
    }

    isActiveSession() {
        const now = new Date();
        const utcHour = now.getUTCHours();
        
        const isLondonSession = utcHour >= this.sessions.london.start && utcHour < this.sessions.london.end;
        const isNewYorkSession = utcHour >= this.sessions.newyork.start && utcHour < this.sessions.newyork.end;
        
        return isLondonSession || isNewYorkSession;
    }

    async loadNewsEvents() {
        // Stub implementation - يمكنك ربطه بـ API حقيقي لاحقاً
        this.newsEvents = new Map();
        console.log('📰 News events: disabled (stub implementation)');
    }

    hasHighImpactNews(symbol, minutesBuffer = 30) {
        // Stub implementation
        return false;
    }
}

// ===============================
// 6. HISTORY QUEUE
// ===============================
class HistoryQueue {
    constructor(ws, onHistoryLoaded) {
        this.ws = ws;
        this.queue = [];
        this.processing = false;
        this.onHistoryLoaded = onHistoryLoaded;
        this.delay = 250;
        this.concurrent = 3;
    }

    add(symbolStore) {
        this.queue.push(symbolStore);
        if (!this.processing) {
            this.processBatch();
        }
    }

    async processBatch() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        const batch = this.queue.splice(0, this.concurrent);

        await Promise.all(batch.map(symbolStore => 
            this.loadSymbolHistory(symbolStore)
        ));

        this.processing = false;
        
        if (this.queue.length > 0) {
            setTimeout(() => this.processBatch(), this.delay);
        }
    }

    async loadSymbolHistory(symbolStore) {
        try {
            console.log(`📥 Loading history for ${symbolStore.symbol}`);
            const candles = await this.ws.requestHistory(symbolStore.symbol);
            
            if (candles && candles.length > 0) {
                symbolStore.candles = candles.map(c => ({
                    start: c.epoch * 1000,
                    open: parseFloat(c.open),
                    high: parseFloat(c.high),
                    low: parseFloat(c.low),
                    close: parseFloat(c.close),
                    volume: parseFloat(c.volume)
                })).slice(-200);
                
                if (symbolStore.candles.length > 0) {
                    symbolStore.lastCandle = symbolStore.candles[symbolStore.candles.length - 1];
                }
                
                console.log(`✅ History loaded for ${symbolStore.symbol}: ${symbolStore.candles.length} candles`);
                
                if (this.onHistoryLoaded) {
                    this.onHistoryLoaded(symbolStore);
                }
            }
        } catch (error) {
            console.error(`❌ Error loading history for ${symbolStore.symbol}:`, error.message);
        }
    }
}

// ===============================
// 7. ADVANCED STRATEGY ENGINE (مع تصحيح RSI)
// ===============================
class AdvancedStrategyEngine {
    constructor(symbolStore) {
        this.store = symbolStore;
        this.compressionData = {
            zoneStart: null,
            zoneHigh: -Infinity,
            zoneLow: Infinity,
            zoneVolume: 0,
            zoneCandleCount: 0,
            isCompressed: false,
            confirmedBreakout: false,
            breakoutDirection: null,
            breakoutTime: null
        };
        this.learningData = {
            successfulSignals: 0,
            totalSignals: 0,
            winRate: 0,
            avgProfit: 0,
            confidenceAdjustment: 1.0
        };
    }

    analyze() {
        const candles = this.store.candles;
        if (candles.length < 50) {
            return { state: 'WAIT', confidence: 0 };
        }

        this.updateLearningData();
        this.updateCompressionZone(candles.slice(-20));
        
        // تصحيح RSI: نستخدم 15 شمعة للحصول على 14 تغيير
        const rsi = TechnicalAnalysis.calculateRSI(candles, 14);
        const sma20 = TechnicalAnalysis.calculateSMA(candles.slice(-20));
        const sma50 = TechnicalAnalysis.calculateSMA(candles.slice(-50));
        const bb = TechnicalAnalysis.calculateBollingerBands(candles.slice(-20));
        const macd = TechnicalAnalysis.calculateMACD(candles);
        const atr = TechnicalAnalysis.calculateATR(candles);
        
        const lastPrice = candles[candles.length - 1].close;
        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles[candles.length - 2] || lastCandle;
        
        const bbPosition = (lastPrice - bb.lower) / (bb.upper - bb.lower);
        const primaryTrend = sma20 > sma50 ? 'BULLISH' : 'BEARISH';
        const trendStrength = Math.abs(sma20 - sma50) / lastPrice;
        
        const compressionAnalysis = this.analyzeCompression(candles);
        const fakeoutAnalysis = this.analyzeFakeout(candles.slice(-10));
        
        const conditions = {
            isInCompression: this.compressionData.isCompressed && 
                           compressionAnalysis.rangeRatio < 0.005,
            
            volumeDecreasing: compressionAnalysis.volumeTrend < -0.2,
            
            rsiNeutral: rsi > 45 && rsi < 55,
            
            noRecentFakeout: !fakeoutAnalysis.hasFakeout,
            
            potentialBreakout: this.checkPotentialBreakout(lastCandle, prevCandle, bb),
            
            trendAlignment: this.checkTrendAlignment(lastCandle, primaryTrend, macd),
            
            bollingerSqueeze: (bb.upper - bb.lower) / lastPrice < 0.01,
            
            macdAlignment: (primaryTrend === 'BULLISH' && macd.histogram > 0) ||
                          (primaryTrend === 'BEARISH' && macd.histogram < 0),
            
            volumeSpike: lastCandle.volume > this.calculateAverageVolume(candles.slice(-10)) * 1.5,
            
            atrLow: atr / lastPrice < 0.001
        };
        
        const weights = this.calculateDynamicWeights(conditions, lastCandle);
        let rawConfidence = 0;
        
        Object.keys(conditions).forEach(key => {
            if (conditions[key]) rawConfidence += weights[key];
        });
        
        let confidence = rawConfidence * this.learningData.confidenceAdjustment;
        
        let state = 'WAIT';
        let watchStrength = 0;
        
        const watchConditions = [
            conditions.isInCompression,
            conditions.volumeDecreasing,
            conditions.rsiNeutral,
            conditions.noRecentFakeout
        ];
        
        const strongWatchConditions = [
            conditions.bollingerSqueeze,
            conditions.atrLow,
            conditions.macdAlignment
        ];
        
        const watchScore = watchConditions.filter(Boolean).length;
        const strongWatchScore = strongWatchConditions.filter(Boolean).length;
        
        if (watchScore >= 3) {
            state = 'WATCH';
            watchStrength = 1;
            
            if (strongWatchScore >= 2 && watchScore >= 4) {
                watchStrength = 2;
                confidence += 15;
            }
        }
        
        const readyConditions = [
            this.compressionData.confirmedBreakout,
            conditions.potentialBreakout,
            conditions.trendAlignment,
            conditions.volumeSpike,
            this.checkBreakoutConfirmation(lastCandle, prevCandle, bb)
        ];
        
        const readyScore = readyConditions.filter(Boolean).length;
        
        if (readyScore >= 4 && watchStrength >= 1) {
            state = 'READY';
            confidence = Math.min(confidence + 20, 95);
        }
        
        if (state === 'READY' && watchStrength < 1) {
            state = 'WATCH';
            confidence -= 10;
        }
        
        if (this.store.hasHighImpactNews) {
            state = 'WAIT';
            confidence *= 0.7;
        }
        
        if (!this.store.isActiveSessionTime) {
            confidence *= 0.8;
        }
        
        return {
            state,
            watchStrength,
            confidence: Math.round(confidence),
            direction: this.getDirection(lastCandle, primaryTrend, macd),
            rsi: Math.round(rsi),
            sma20: sma20.toFixed(5),
            sma50: sma50.toFixed(5),
            price: lastPrice.toFixed(5),
            compression: this.compressionData.isCompressed,
            compressionRange: compressionAnalysis.rangeRatio,
            fakeoutAlert: fakeoutAnalysis.hasFakeout,
            bollingerWidth: (bb.upper - bb.lower) / lastPrice, // رقم وليس نص
            atrPct: (atr / lastPrice) * 100, // رقم وليس نص
            macdHistogram: macd.histogram.toFixed(5),
            reasons: this.generateAdvancedReasons(conditions, compressionAnalysis, fakeoutAnalysis),
            entryTime: this.calculateSmartEntryTime(lastCandle, state),
            sessionFiltered: !this.store.isActiveSessionTime,
            newsFiltered: this.store.hasHighImpactNews
        };
    }
    
    updateLearningData() {
        if (this.learningData.totalSignals > 10) {
            this.learningData.winRate = this.learningData.successfulSignals / this.learningData.totalSignals;
            
            if (this.learningData.winRate > 0.6) {
                this.learningData.confidenceAdjustment = 1.1;
            } else if (this.learningData.winRate < 0.4) {
                this.learningData.confidenceAdjustment = 0.9;
            } else {
                this.learningData.confidenceAdjustment = 1.0;
            }
        }
    }
    
    calculateDynamicWeights(conditions, lastCandle) {
        const baseWeights = {
            isInCompression: 20,
            volumeDecreasing: 15,
            rsiNeutral: 10,
            noRecentFakeout: 15,
            potentialBreakout: 20,
            trendAlignment: 10,
            bollingerSqueeze: 12,
            macdAlignment: 8,
            volumeSpike: 15,
            atrLow: 10
        };
        
        const candleSize = (lastCandle.high - lastCandle.low) / lastCandle.low;
        if (candleSize > 0.005) {
            baseWeights.volumeSpike += 5;
            baseWeights.trendAlignment += 5;
        }
        
        return baseWeights;
    }
    
    updateCompressionZone(recentCandles) {
        if (recentCandles.length < 10) return;
        
        let high = -Infinity;
        let low = Infinity;
        let totalVolume = 0;
        let totalRange = 0;
        
        recentCandles.forEach(candle => {
            high = Math.max(high, candle.high);
            low = Math.min(low, candle.low);
            totalVolume += candle.volume;
            totalRange += (candle.high - candle.low);
        });
        
        const avgRange = totalRange / recentCandles.length;
        const rangeRatio = (high - low) / low;
        
        this.compressionData.zoneHigh = high;
        this.compressionData.zoneLow = low;
        this.compressionData.zoneVolume = totalVolume;
        this.compressionData.zoneCandleCount = recentCandles.length;
        this.compressionData.isCompressed = rangeRatio < 0.008 && avgRange < (totalRange / 20) * 0.6;
        
        const lastCandle = recentCandles[recentCandles.length - 1];
        if (this.compressionData.isCompressed) {
            if (lastCandle.close > high || lastCandle.close < low) {
                this.compressionData.confirmedBreakout = true;
                this.compressionData.breakoutDirection = lastCandle.close > high ? 'BULLISH' : 'BEARISH';
                this.compressionData.breakoutTime = Date.now();
            }
        } else {
            this.compressionData.confirmedBreakout = false;
        }
    }
    
    analyzeCompression(candles) {
        const range = this.compressionData.zoneHigh - this.compressionData.zoneLow;
        const midPrice = (this.compressionData.zoneHigh + this.compressionData.zoneLow) / 2;
        const rangeRatio = range / midPrice;
        
        if (candles.length >= 10) {
            const first5Volume = candles.slice(-10, -5).reduce((sum, c) => sum + c.volume, 0) / 5;
            const last5Volume = candles.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5;
            const volumeTrend = (last5Volume - first5Volume) / first5Volume;
            
            return {
                rangeRatio,
                volumeTrend,
                isStrongCompression: rangeRatio < 0.005 && volumeTrend < -0.3
            };
        }
        
        return { rangeRatio, volumeTrend: 0, isStrongCompression: false };
    }
    
    analyzeFakeout(recentCandles) {
        if (recentCandles.length < 5) return { hasFakeout: false };
        
        let fakeoutCount = 0;
        for (let i = 1; i < recentCandles.length - 1; i++) {
            const prev = recentCandles[i-1];
            const current = recentCandles[i];
            const next = recentCandles[i+1];
            
            if ((current.close > prev.high && next.close < prev.high) ||
                (current.close < prev.low && next.close > prev.low)) {
                fakeoutCount++;
            }
        }
        
        return {
            hasFakeout: fakeoutCount > 0,
            fakeoutCount,
            fakeoutRatio: fakeoutCount / (recentCandles.length - 2)
        };
    }
    
    checkPotentialBreakout(currentCandle, prevCandle, bb) {
        if (!this.compressionData.isCompressed) return false;
        
        const zoneHigh = this.compressionData.zoneHigh;
        const zoneLow = this.compressionData.zoneLow;
        const position = (currentCandle.close - zoneLow) / (zoneHigh - zoneLow);
        
        const nearEdge = position > 0.7 || position < 0.3;
        const increasingVolume = currentCandle.volume > prevCandle.volume * 1.2;
        const closingStrong = Math.abs(currentCandle.close - currentCandle.open) > 
                            (currentCandle.high - currentCandle.low) * 0.6;
        const nearBollinger = currentCandle.close > bb.upper * 0.98 || 
                             currentCandle.close < bb.lower * 1.02;
        
        return nearEdge && increasingVolume && closingStrong && nearBollinger;
    }
    
    checkTrendAlignment(candle, primaryTrend, macd) {
        const isBullishCandle = candle.close > candle.open;
        const candleStrength = Math.abs(candle.close - candle.open) / (candle.high - candle.low);
        
        if (primaryTrend === 'BULLISH') {
            return isBullishCandle && candleStrength > 0.4 && macd.histogram > -0.0001;
        } else {
            return !isBullishCandle && candleStrength > 0.4 && macd.histogram < 0.0001;
        }
    }
    
    checkBreakoutConfirmation(currentCandle, prevCandle, bb) {
        if (!this.compressionData.confirmedBreakout) return false;
        
        const breakoutDir = this.compressionData.breakoutDirection;
        const zoneHigh = this.compressionData.zoneHigh;
        const zoneLow = this.compressionData.zoneLow;
        
        if (breakoutDir === 'BULLISH') {
            return currentCandle.close > zoneHigh && 
                   currentCandle.close > currentCandle.open &&
                   currentCandle.volume > prevCandle.volume &&
                   currentCandle.close > bb.middle;
        } else {
            return currentCandle.close < zoneLow && 
                   currentCandle.close < currentCandle.open &&
                   currentCandle.volume > prevCandle.volume &&
                   currentCandle.close < bb.middle;
        }
    }
    
    getDirection(candle, primaryTrend, macd) {
        if (this.compressionData.confirmedBreakout) {
            return this.compressionData.breakoutDirection === 'BULLISH' ? 'CALL' : 'PUT';
        }
        
        if (this.compressionData.isCompressed) {
            const potential = this.checkPotentialBreakout(candle, 
                this.store.candles[this.store.candles.length - 2] || candle, 
                TechnicalAnalysis.calculateBollingerBands(this.store.candles.slice(-20))
            );
            
            return potential ? 
                (candle.close > (this.compressionData.zoneHigh + this.compressionData.zoneLow) / 2 ? 'CALL' : 'PUT') : 
                'WAIT';
        }
        
        if (primaryTrend === 'BULLISH' && macd.histogram > 0) return 'CALL';
        if (primaryTrend === 'BEARISH' && macd.histogram < 0) return 'PUT';
        
        return primaryTrend === 'BULLISH' ? 'CALL' : 'PUT';
    }
    
    calculateSmartEntryTime(currentCandle, state) {
        const now = Date.now();
        const currentMinute = Math.floor(now / 60000);
        
        if (state === 'WATCH') {
            const minutesToNextCandle = 60 - (Math.floor(now / 1000) % 60) / 60;
            return Math.max(1, Math.ceil(minutesToNextCandle));
        }
        
        if (state === 'READY') {
            const nextCandleStart = (currentMinute + 1) * 60000;
            const minutesToEntry = Math.ceil((nextCandleStart - now) / 60000);
            return Math.max(1, minutesToEntry);
        }
        
        return 0;
    }
    
    calculateAverageVolume(candles) {
        if (candles.length === 0) return 0;
        return candles.reduce((acc, c) => acc + c.volume, 0) / candles.length;
    }
    
    generateAdvancedReasons(conditions, compression, fakeout) {
        const reasons = [];
        
        if (conditions.isInCompression) {
            reasons.push(`ضغط قوي (نطاق: ${(compression.rangeRatio*100).toFixed(2)}%)`);
        }
        
        if (conditions.volumeDecreasing) {
            reasons.push('حجم متضائل قبل الكسر');
        }
        
        if (conditions.noRecentFakeout && fakeout.fakeoutCount === 0) {
            reasons.push('لا يوجد كسور كاذبة حديثة');
        }
        
        if (conditions.bollingerSqueeze) {
            reasons.push('نطاق بولنجر مضغوط');
        }
        
        if (conditions.potentialBreakout) {
            reasons.push('إشارات كسر محتمل قوية');
        }
        
        if (conditions.macdAlignment) {
            reasons.push('توافق MACD مع الاتجاه');
        }
        
        if (this.compressionData.confirmedBreakout) {
            reasons.push(`كسر مؤكد ${this.compressionData.breakoutDirection === 'BULLISH' ? 'صاعد' : 'هابط'}`);
        }
        
        return reasons.slice(0, 3);
    }
}

// ===============================
// 8. PRODUCTION TRADING MONITOR (مع كل التصحيحات)
// ===============================
class ProductionTradingMonitor {
    constructor() {
        this.appId = process.env.DERIV_APP_ID;
        this.ws = new ProductionDerivWebSocket(this.appId);
        this.telegram = new TelegramSender();
        this.symbolStores = new Map();
        this.historyQueue = null;
        this.analysisInterval = null;
        
        // إصلاح: startTime مفقود
        this.startTime = Date.now();
        
        // إصلاح: totalSignals مفقود
        this.performanceStats = {
            signalsSent: 0,
            successfulSignals: 0,
            totalSignals: 0, // ✅ أضيف
            winRate: 0,
            fakeoutsDetected: 0,
            compressionsFound: 0,
            falsePositives: 0,
            sessionFiltered: 0,
            newsFiltered: 0
        };
        
        // إصلاح: للتقارير المنتظمة
        this.lastReportTime = 0;
        this.lastHourlyReportTime = 0;
        
        this.setupWebSocketHandlers();
        this.initialize();
    }
    
    setupWebSocketHandlers() {
        this.ws.onTick = (tick) => this.handleTick(tick);
    }

    async initialize() {
        console.log('🚀 Starting Production Trading Monitor v2.1 (Corrected)...');
        
        await this.ws.loadNewsEvents();
        this.ws.connect();
        
        await this.waitForConnection();
        const symbols = await this.loadSymbols();
        
        this.historyQueue = new HistoryQueue(this.ws, (symbolStore) => {
            setTimeout(() => {
                this.ws.subscribeTicks(symbolStore.symbol);
            }, Math.random() * 5000);
            
            this.analyzeSymbol(symbolStore);
        });
        
        await this.createSymbolStores(symbols);
        this.startAnalysisScheduler();
        this.startPerformanceMonitor();
        this.startSessionMonitor();
        
        console.log(`🎯 Production System Active: ${symbols.length} symbols`);
    }
    
    async waitForConnection() {
        return new Promise((resolve) => {
            const checkConnection = setInterval(() => {
                if (this.ws.connected) {
                    clearInterval(checkConnection);
                    resolve();
                }
            }, 100);
        });
    }
    
    async loadSymbols() {
        return new Promise((resolve) => {
            this.ws.sendRequest({
                active_symbols: "brief",
                product_type: "basic"
            }, (response) => {
                if (response.msg_type === 'active_symbols') {
                    const symbols = response.active_symbols
                        .filter(sym => {
                            const market = sym.market.toLowerCase();
                            const isAllowed = market.includes('forex') || 
                                             market.includes('crypto') || 
                                             market.includes('commodit');
                            const isOTC = sym.display_name.includes('OTC') || 
                                         sym.symbol.includes('OTC') ||
                                         sym.symbol.includes('_OTC');
                            return isAllowed && !isOTC;
                        })
                        .map(sym => ({
                            symbol: sym.symbol,
                            display_name: sym.display_name,
                            market: sym.market,
                            pip: sym.pip
                            // إصلاح: لا نخزن session/news هنا
                        }));
                    
                    resolve(symbols);
                }
            });
        });
    }
    
    async createSymbolStores(symbols) {
        const batchSize = 10;
        for (let i = 0; i < symbols.length; i += batchSize) {
            const batch = symbols.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (symbolInfo) => {
                const store = new SymbolStore(symbolInfo);
                this.symbolStores.set(symbolInfo.symbol, store);
                this.historyQueue.add(store);
            }));
            
            if (i + batchSize < symbols.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    
    handleTick(tick) {
        const symbolStore = this.symbolStores.get(tick.symbol);
        if (!symbolStore) return;
        
        const isNewCandle = symbolStore.updateCandle(tick);
        
        if (isNewCandle) {
            this.analyzeSymbol(symbolStore);
        }
    }
    
    analyzeSymbol(symbolStore) {
        const now = Date.now();
        
        if (now - symbolStore.lastAnalysisTime < 15000) {
            return;
        }
        
        symbolStore.lastAnalysisTime = now;
        
        // إصلاح: تحديث session/news في كل تحليل
        symbolStore.isActiveSessionTime = this.ws.isActiveSession();
        symbolStore.hasHighImpactNews = this.ws.hasHighImpactNews(symbolStore.symbol);
        
        const engine = new AdvancedStrategyEngine(symbolStore);
        const analysis = engine.analyze();
        
        symbolStore.analysis = analysis;
        symbolStore.state = analysis.state;
        
        if (analysis.compression) this.performanceStats.compressionsFound++;
        if (analysis.fakeoutAlert) this.performanceStats.fakeoutsDetected++;
        if (analysis.sessionFiltered) this.performanceStats.sessionFiltered++;
        if (analysis.newsFiltered) this.performanceStats.newsFiltered++;
        
        if (analysis.state === 'READY' && analysis.confidence >= 75) {
            this.sendSignal(symbolStore, analysis, engine);
        }
    }
    
    async sendSignal(symbolStore, analysis, engine) {
        const signalHash = this.generateSignalHash(symbolStore, analysis);
        
        if (symbolStore.lastSignalHash === signalHash && 
            Date.now() - symbolStore.lastSignalTime < 2 * 60 * 60 * 1000) {
            return;
        }
        
        if (!this.confirmWithPreviousCandle(symbolStore, analysis)) {
            this.performanceStats.falsePositives++;
            return;
        }
        
        const message = this.createProductionTelegramMessage(symbolStore, analysis);
        
        const sent = await this.telegram.sendTelegram(message, symbolStore.symbol, signalHash);
        
        if (sent) {
            symbolStore.lastSignalHash = signalHash;
            symbolStore.lastSignalTime = Date.now();
            symbolStore.cooldownUntil = Date.now() + 30 * 60 * 1000;
            
            this.performanceStats.signalsSent++;
            this.logProductionSignal(symbolStore, analysis, signalHash);
            
            setTimeout(() => {
                this.evaluateSignal(symbolStore, analysis);
            }, 5 * 60 * 1000);
        }
    }
    
    generateSignalHash(symbolStore, analysis) {
        const recentCandles = symbolStore.candles.slice(-3);
        const candlePattern = recentCandles.map(c => 
            `${c.close > c.open ? 'B' : 'S'}_${((c.high-c.low)/c.low*1000).toFixed(0)}`
        ).join('-');
        
        return `${symbolStore.symbol}_${analysis.direction}_${analysis.confidence}_${candlePattern}_${analysis.watchStrength}`;
    }
    
    confirmWithPreviousCandle(symbolStore, analysis) {
        const candles = symbolStore.candles;
        if (candles.length < 3) return false;
        
        const current = candles[candles.length - 1];
        const previous = candles[candles.length - 2];
        
        if (analysis.direction === 'CALL') {
            return !(previous.close < previous.open && 
                   Math.abs(previous.close - previous.open) > (previous.high - previous.low) * 0.7);
        } else {
            return !(previous.close > previous.open && 
                   Math.abs(previous.close - previous.open) > (previous.high - previous.low) * 0.7);
        }
    }
    
    async evaluateSignal(symbolStore, originalAnalysis) {
        try {
            const currentPrice = await this.getCurrentPrice(symbolStore.symbol);
            const entryPrice = parseFloat(originalAnalysis.price);
            const direction = originalAnalysis.direction;
            
            let isSuccessful = false;
            
            if (direction === 'CALL') {
                isSuccessful = currentPrice > entryPrice * 1.001;
            } else {
                isSuccessful = currentPrice < entryPrice * 0.999;
            }
            
            if (isSuccessful) {
                this.performanceStats.successfulSignals++;
            }
            
            this.performanceStats.totalSignals++;
            this.performanceStats.winRate = 
                this.performanceStats.successfulSignals / this.performanceStats.totalSignals;
            
            console.log(`📊 Signal Evaluation: ${symbolStore.symbol} ${direction} - ${isSuccessful ? '✅ WIN' : '❌ LOSS'}`);
            
        } catch (error) {
            console.error('❌ Error evaluating signal:', error.message);
        }
    }
    
    // إصلاح كبير: getCurrentPrice بدون memory leak
    async getCurrentPrice(symbol) {
        return new Promise((resolve) => {
            let done = false;
            let timeoutId = null;

            this.ws.sendRequest({ 
                ticks: symbol, 
                subscribe: 1 
            }, (response) => {
                if (done) return;
                done = true;
                
                if (timeoutId) clearTimeout(timeoutId);
                
                if (response.error) {
                    console.error(`❌ Error getting price for ${symbol}:`, response.error);
                    return resolve(0);
                }

                if (response.tick?.quote && response.subscription?.id) {
                    const price = response.tick.quote;
                    const subId = response.subscription.id;

                    // إلغاء الاشتراك فوراً
                    this.ws.sendRequest({ forget: subId }, () => {
                        // تجاهل الرد
                    });
                    
                    return resolve(price);
                }
                
                resolve(0);
            });

            // Timeout للسلامة
            timeoutId = setTimeout(() => {
                if (!done) {
                    done = true;
                    console.error(`❌ Timeout getting price for ${symbol}`);
                    resolve(0);
                }
            }, 10000);
        });
    }
    
    createProductionTelegramMessage(symbolStore, analysis) {
        const entryText = analysis.entryTime === 1 ? 'بعد دقيقة واحدة' : 
                         `بعد ${analysis.entryTime} دقائق`;
        
        const sessionWarning = analysis.sessionFiltered ? 
            '\n⚠️ <b>ملاحظة:</b> خارج أوقات الجلسات الرئيسية' : '';
        
        const newsWarning = analysis.newsFiltered ? 
            '\n⚠️ <b>تحذير:</b> توجد أخبار اقتصادية هامة قريبة' : '';
        
        return `🎯 <b>إشارة تداول - نظام متقدم</b>

📊 <b>${symbolStore.name} (${symbolStore.symbol})</b>
🏪 السوق: ${symbolStore.market}
⏰ الجلسة: ${analysis.sessionFiltered ? 'غير رئيسية' : 'نشطة'}

🚀 <b>الاتجاه: ${analysis.direction === 'CALL' ? 'شراء 📈' : 'بيع 📉'}</b>
⏰ <b>الدخول: ${entryText}</b>
⏳ المدة المقترحة: 1-2 دقيقة
📈 الثقة: ${analysis.confidence}%

🔍 <b>تحليل النمط:</b>
${analysis.compression ? '✅ في منطقة ضغط' : '❌ لا يوجد ضغط'}
${analysis.fakeoutAlert ? '⚠️ كسور كاذبة حديثة' : '✅ لا توجد كسور كاذبة'}
نطاق بولنجر: ${(analysis.bollingerWidth * 100).toFixed(2)}%
ATR: ${analysis.atrPct.toFixed(3)}%

📋 <b>أسباب الإشارة:</b>
${analysis.reasons.map((r, i) => `${i+1}. ${r}`).join('\n')}

💰 <b>البيانات الفنية:</b>
السعر: ${analysis.price}
RSI: ${analysis.rsi}
SMA20: ${analysis.sma20}
SMA50: ${analysis.sma50}
MACD: ${analysis.macdHistogram}

${sessionWarning}${newsWarning}

⚠️ <b>تعليمات التنفيذ:</b>
1. انتظر بداية الشمعة الجديدة
2. إذا فاتك 30 ثانية، تجاهل الإشارة
3. استخدم وقف خسارة 1.5x الربح المستهدف
4. هذه إشارة آلية تحتاج تأكيد بصري

📊 <b>إحصائيات النظام:</b>
• ${this.performanceStats.signalsSent} إشارة مرسلة
• ${this.performanceStats.successfulSignals} إشارة ناجحة
• Win Rate: ${(this.performanceStats.winRate * 100).toFixed(1)}%
• ${this.performanceStats.compressionsFound} منطقة ضغط تم رصدها

#${symbolStore.symbol.replace('.', '').slice(0, 6)}`;
    }
    
    logProductionSignal(symbolStore, analysis, hash) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            symbol: symbolStore.symbol,
            direction: analysis.direction,
            confidence: analysis.confidence,
            entryTime: analysis.entryTime,
            price: analysis.price,
            compression: analysis.compression,
            fakeout: analysis.fakeoutAlert,
            watchStrength: analysis.watchStrength || 0,
            state: analysis.state,
            sessionFiltered: analysis.sessionFiltered,
            newsFiltered: analysis.newsFiltered,
            hash: hash
        };
        
        console.log('📝 Production Signal:', JSON.stringify(logEntry, null, 2));
        this.saveToDatabase(logEntry);
    }
    
    saveToDatabase(logEntry) {
        // يمكنك تفعيل هذا لاحقاً
        // fs.appendFileSync('signals.json', JSON.stringify(logEntry) + '\n');
    }
    
    startAnalysisScheduler() {
        this.analysisInterval = setInterval(() => {
            const now = Date.now();
            this.symbolStores.forEach(store => {
                if (now - store.lastAnalysisTime > 30000) {
                    this.analyzeSymbol(store);
                }
            });
        }, 30000);
    }
    
    startPerformanceMonitor() {
        // إصلاح: استخدام طريقة time-based بدلاً من modulo
        setInterval(() => {
            const now = Date.now();
            
            // تقرير كل 5 دقائق
            if (now - this.lastReportTime >= 5 * 60 * 1000) {
                this.lastReportTime = now;
                this.printPerformanceReport();
            }
            
            // تقرير ساعي
            if (now - this.lastHourlyReportTime >= 60 * 60 * 1000) {
                this.lastHourlyReportTime = now;
                this.printHourlyReport();
            }
            
        }, 1000);
    }
    
    printPerformanceReport() {
        const stats = this.getPerformanceStats();
        
        console.log('\n📊 Performance Report (5min):');
        console.log('============================');
        console.log(`Uptime: ${this.formatUptime()}`);
        console.log(`Active Symbols: ${stats.activeSymbols}`);
        console.log(`WS Status: ${stats.wsConnected ? '✅' : '❌'}`);
        console.log(`Signals Sent: ${stats.signalsSent}`);
        console.log(`Win Rate: ${(stats.winRate * 100).toFixed(1)}%`);
        console.log(`False Positives: ${stats.falsePositives}`);
        console.log(`Session Filtered: ${stats.sessionFiltered}`);
        console.log(`News Filtered: ${stats.newsFiltered}`);
        console.log(`System Health: ${stats.winRate > 0.5 ? '✅ GOOD' : '⚠️ NEEDS ATTENTION'}`);
        console.log('============================\n');
        
        if (stats.winRate < 0.4 && stats.signalsSent > 10) {
            console.warn('⚠️ WARNING: System win rate is below 40%');
        }
    }
    
    printHourlyReport() {
        const stats = this.getPerformanceStats();
        const uptime = this.formatUptime();
        
        console.log('\n⏰ Hourly System Report:');
        console.log('=======================');
        console.log(`System Uptime: ${uptime}`);
        console.log(`Total Signals: ${stats.signalsSent}`);
        console.log(`Successful: ${stats.successfulSignals}`);
        console.log(`Win Rate: ${(stats.winRate * 100).toFixed(1)}%`);
        console.log(`Compressions Found: ${stats.compressionsFound}`);
        console.log(`Fakeouts Detected: ${stats.fakeoutsDetected}`);
        console.log(`Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
        console.log('=======================\n');
    }
    
    startSessionMonitor() {
        setInterval(() => {
            this.symbolStores.forEach(store => {
                store.isActiveSessionTime = this.ws.isActiveSession();
                store.hasHighImpactNews = this.ws.hasHighImpactNews(store.symbol);
            });
        }, 60 * 60 * 1000);
    }
    
    formatUptime() {
        const uptime = Date.now() - this.startTime;
        const hours = Math.floor(uptime / (1000 * 60 * 60));
        const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((uptime % (1000 * 60)) / 1000);
        return `${hours}h ${minutes}m ${seconds}s`;
    }
    
    getPerformanceStats() {
        const totalSignals = this.performanceStats.totalSignals || 1;
        const accuracyRate = this.performanceStats.signalsSent > 0 ? 
            (this.performanceStats.signalsSent / (this.performanceStats.signalsSent + this.performanceStats.falsePositives) * 100).toFixed(1) : 0;
        
        return {
            ...this.performanceStats,
            accuracyRate,
            activeSymbols: this.symbolStores.size,
            wsConnected: this.ws.connected
        };
    }
}

// ===============================
// 9. TRADING SYSTEM (مع تصحيحات التقارير)
// ===============================
class TradingSystem {
    constructor(mode = 'production') {
        this.mode = mode;
        this.monitor = null;
        this.startTime = Date.now();
        this.testDuration = mode === 'test' ? 7 * 24 * 60 * 60 * 1000 : null;
        this.lastTestReportTime = 0;
    }
    
    async start() {
        console.log(`🚀 Starting Trading System v2.1 in ${this.mode.toUpperCase()} mode`);
        
        try {
            this.monitor = new ProductionTradingMonitor();
            
            if (this.mode === 'test') {
                await this.runExtendedTest();
            } else {
                await this.runProduction();
            }
            
        } catch (error) {
            console.error('❌ System startup failed:', error);
            process.exit(1);
        }
    }
    
    async runExtendedTest() {
        console.log('🧪 Running EXTENDED TEST for 7 days...');
        
        const testInterval = setInterval(() => {
            const now = Date.now();
            const uptime = now - this.startTime;
            
            // تقرير ساعي
            if (now - this.lastTestReportTime >= 60 * 60 * 1000) {
                this.lastTestReportTime = now;
                const stats = this.monitor.getPerformanceStats();
                
                console.log('\n🧪 Test Progress:');
                console.log(`Uptime: ${Math.floor(uptime/(1000*60*60))}h`);
                console.log(`Signals: ${stats.signalsSent}`);
                console.log(`Win Rate: ${(stats.winRate * 100).toFixed(1)}%`);
                console.log(`False Positives: ${stats.falsePositives}`);
                console.log(`Accuracy: ${stats.accuracyRate}%`);
            }
            
            // نهاية الاختبار
            if (uptime > this.testDuration) {
                clearInterval(testInterval);
                this.generateTestReport();
            }
        }, 1000);
    }
    
    async generateTestReport() {
        const finalStats = this.monitor.getPerformanceStats();
        
        console.log('\n' + '='.repeat(50));
        console.log('✅ 7-DAY TEST COMPLETED SUCCESSFULLY!');
        console.log('='.repeat(50));
        console.log(`Total Runtime: 7 days`);
        console.log(`Signals Generated: ${finalStats.signalsSent}`);
        console.log(`Successful Signals: ${finalStats.successfulSignals}`);
        console.log(`Win Rate: ${(finalStats.winRate * 100).toFixed(1)}%`);
        console.log(`Compression Zones Found: ${finalStats.compressionsFound}`);
        console.log(`Fakeouts Detected: ${finalStats.fakeoutsDetected}`);
        console.log(`False Positives: ${finalStats.falsePositives}`);
        console.log(`Session Filtered: ${finalStats.sessionFiltered}`);
        console.log(`News Filtered: ${finalStats.newsFiltered}`);
        console.log(`Final Accuracy: ${finalStats.accuracyRate}%`);
        console.log('='.repeat(50));
        
        if (finalStats.winRate > 0.55 && finalStats.signalsSent > 50) {
            console.log('🎯 TEST PASSED: System ready for production!');
            this.provideRecommendations(finalStats);
            process.exit(0);
        } else {
            console.log('❌ TEST FAILED: Need strategy adjustments');
            console.log('💡 Recommendations:');
            console.log('1. Increase confidence threshold to 80%');
            console.log('2. Add more confirmation filters');
            console.log('3. Review compression zone parameters');
            process.exit(1);
        }
    }
    
    provideRecommendations(stats) {
        console.log('\n💡 Production Recommendations:');
        
        if (stats.winRate > 0.65) {
            console.log('✅ Excellent win rate - Consider reducing cooldown to 20 minutes');
        }
        
        if (stats.falsePositives > stats.signalsSent * 0.3) {
            console.log('⚠️ High false positives - Increase confirmation requirements');
        }
        
        if (stats.sessionFiltered > stats.signalsSent * 0.5) {
            console.log('⚠️ Many signals filtered by session - Consider expanding session hours');
        }
        
        console.log('📊 Optimal Configuration:');
        console.log('- Confidence Threshold: 75%');
        console.log('- Cooldown: 30 minutes');
        console.log('- Session Filter: Enabled');
        console.log('- News Filter: Enabled');
    }
    
    async runProduction() {
        console.log('🏭 Running in PRODUCTION mode');
        
        // إصلاح: استخدام time-based للتقارير
        let lastProductionReport = 0;
        
        setInterval(() => {
            const now = Date.now();
            
            if (now - lastProductionReport >= 5 * 60 * 1000) {
                lastProductionReport = now;
                const stats = this.monitor.getPerformanceStats();
                const uptime = now - this.startTime;
                
                console.log('\n🏭 Production Status:');
                console.log(`Uptime: ${Math.floor(uptime/(1000*60*60))}h ${Math.floor((uptime%(1000*60*60))/(1000*60))}m`);
                console.log(`Active Symbols: ${stats.activeSymbols}`);
                console.log(`WS Status: ${stats.wsConnected ? '✅' : '❌'}`);
                console.log(`Total Signals: ${stats.signalsSent}`);
                console.log(`Current Win Rate: ${(stats.winRate * 100).toFixed(1)}%`);
                console.log(`System Health: ${stats.winRate > 0.5 ? '✅ GOOD' : '⚠️ NEEDS ATTENTION'}`);
            }
        }, 1000);
    }
}

// ===============================
// 10. MAIN EXECUTION
// ===============================
async function main() {
    const mode = process.argv[2] || 'production';
    
    const requiredEnvVars = ['DERIV_APP_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
        console.error('❌ Missing environment variables:', missingVars.join(', '));
        console.error('Please create a .env file with:');
        console.error('DERIV_APP_ID=your_app_id');
        console.error('TELEGRAM_BOT_TOKEN=your_bot_token');
        console.error('TELEGRAM_CHAT_ID=your_chat_id');
        process.exit(1);
    }
    
    const system = new TradingSystem(mode);
    await system.start();
}

// ===============================
// 11. EXPORTS (للاستخدام كـ module)
// ===============================
module.exports = {
    ProductionTradingMonitor,
    AdvancedStrategyEngine,
    TechnicalAnalysis,
    ProductionDerivWebSocket,
    TradingSystem,
    TelegramSender,
    SymbolStore
};

// ===============================
// 12. RUN IF EXECUTED DIRECTLY
// ===============================
if (require.main === module) {
    main();
}
