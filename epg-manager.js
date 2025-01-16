const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const cron = require('node-cron');

class EPGManager {
    constructor() {
        this.epgData = null;
        this.programGuide = new Map();
        this.lastUpdate = null;
        this.isUpdating = false;
        this.CHUNK_SIZE = 10000;
        this.CHUNK_DELAY = 60000; // 1 minuto
    }

    // Funzione helper per parsare le date EPG
    parseEPGDate(dateString) {
        if (!dateString) return null;
        try {
            // Formato base: "20250117063000 +0000"
            const regex = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/;
            const match = dateString.match(regex);
            
            if (!match) {
                console.log(`[EPG] Formato data non valido: ${dateString}`);
                return null;
            }
            
            const [_, year, month, day, hour, minute, second, timezone] = match;
            
            // Costruisci la data in formato ISO
            const tzHours = timezone.substring(0, 3);
            const tzMinutes = timezone.substring(3);
            const isoString = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzHours}:${tzMinutes}`;
            
            const date = new Date(isoString);
            
            // Verifica validità
            if (isNaN(date.getTime())) {
                console.log(`[EPG] Data risultante non valida: ${isoString}`);
                return null;
            }
            
            return date;
        } catch (error) {
            console.log(`[EPG] Errore nel parsing della data: ${dateString}`, error.message);
            return null;
        }
    }

    async initializeEPG(url) {
        console.log('Inizializzazione EPG...');
        
        // Pianifica l'aggiornamento alle 3 del mattino
        cron.schedule('0 3 * * *', () => {
            console.log('Avvio aggiornamento EPG pianificato');
            this.startEPGUpdate(url);
        });

        // Esegui immediatamente il primo aggiornamento solo se non ci sono dati
        if (!this.programGuide.size) {
            console.log('Primo caricamento EPG...');
            await this.startEPGUpdate(url);
        } else {
            console.log('EPG già caricato, skip primo caricamento');
        }
    }

    async startEPGUpdate(url) {
        if (this.isUpdating) {
            console.log('Aggiornamento EPG già in corso, skip...');
            return;
        }

        try {
            this.isUpdating = true;
            console.log('Scaricamento EPG da:', url);
            
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            let xmlString;

            // Prova a decomprimere come gzip
            try {
                const decompressed = await gunzip(response.data);
                xmlString = decompressed.toString();
            } catch (gzipError) {
                // Se fallisce, assume che sia già un XML non compresso
                console.log('File non compresso in gzip, processamento diretto...');
                xmlString = response.data.toString();
            }

            // Parsa l'XML
            const xmlData = await parseStringPromise(xmlString);
            
            // Reset della guida programmi
            this.programGuide.clear();
            
            // Avvia il processamento progressivo
            await this.processEPGInChunks(xmlData);
            
        } catch (error) {
            console.error('Errore nell\'aggiornamento EPG:', error);
            this.isUpdating = false;
        }
    }

    async processEPGInChunks(data) {
        if (!data.tv || !data.tv.programme) {
            console.log('Nessun dato EPG trovato');
            this.isUpdating = false;
            return;
        }

        const programmes = data.tv.programme;
        const totalChunks = Math.ceil(programmes.length / this.CHUNK_SIZE);
        
        console.log(`\n=== Inizio processamento EPG: ${programmes.length} programmi totali ===`);
        
        // Log dei primi programmi RAI per debug
        const raiPrograms = programmes.filter(p => p.$.channel.toLowerCase().includes('rai')).slice(0, 3);
        if (raiPrograms.length > 0) {
            console.log('\nEsempio programmi RAI trovati nell\'EPG:');
            raiPrograms.forEach(p => {
                console.log(`\nCanale: ${p.$.channel}`);
                console.log('Start:', p.$.start);
                console.log('Stop:', p.$.stop);
                console.log('Titolo:', p.title?.[0]?._ || p.title?.[0]);
                console.log('-----------------');
            });
        }

        // Counter per tenere traccia dei programmi processati
        const processedPrograms = new Map();

        for (let i = 0; i < programmes.length; i += this.CHUNK_SIZE) {
            const chunk = programmes.slice(i, i + this.CHUNK_SIZE);
            const chunkNumber = Math.floor(i / this.CHUNK_SIZE) + 1;
            
            for (const programme of chunk) {
                const channelId = programme.$.channel;

                // Inizializza contatori
                if (!processedPrograms.has(channelId)) {
                    processedPrograms.set(channelId, {
                        total: 0,
                        valid: 0,
                        skipped: 0
                    });
                }
                const counter = processedPrograms.get(channelId);
                counter.total++;

                if (!this.programGuide.has(channelId)) {
                    this.programGuide.set(channelId, []);
                }

                const start = this.parseEPGDate(programme.$.start);
                const stop = this.parseEPGDate(programme.$.stop);

                // Debug per date non valide
                if (!start || !stop || isNaN(start) || isNaN(stop)) {
                    counter.skipped++;
                    if (channelId.toLowerCase().includes('rai')) {
                        console.log(`[Debug] Date non valide per ${channelId}:`, {
                            start: programme.$.start,
                            parsed_start: start,
                            stop: programme.$.stop,
                            parsed_stop: stop
                        });
                    }
                    continue;
                }

                const programData = {
                    start,
                    stop,
                    title: programme.title?.[0]?._
                           || programme.title?.[0]?.$?.text 
                           || programme.title?.[0] 
                           || 'Nessun titolo',
                    description: programme.desc?.[0]?._
                                || programme.desc?.[0]?.$?.text 
                                || programme.desc?.[0] 
                                || '',
                    category: programme.category?.[0]?._ 
                             || programme.category?.[0]?.$?.text 
                             || programme.category?.[0] 
                             || ''
                };

                this.programGuide.get(channelId).push(programData);
                counter.valid++;
            }

            console.log(`Completato chunk ${chunkNumber}/${totalChunks}`);
        }

        // Ordina i programmi per ogni canale
        for (const [channelId, programs] of this.programGuide.entries()) {
            this.programGuide.set(
                channelId, 
                programs.sort((a, b) => a.start - b.start)
            );
        }

        // Log riepilogativo
        console.log('\n=== Riepilogo Canali EPG ===');
        console.log('Totale canali trovati:', this.programGuide.size);
        console.log('\nDettaglio canali RAI:');
        for (const [channelId, stats] of processedPrograms.entries()) {
            if (channelId.toLowerCase().includes('rai')) {
                console.log(`\nCanale: ${channelId}`);
                console.log(`- Programmi totali processati: ${stats.total}`);
                console.log(`- Programmi validi salvati: ${stats.valid}`);
                console.log(`- Programmi saltati: ${stats.skipped}`);
                console.log(`- Programmi nella guida: ${this.programGuide.get(channelId)?.length || 0}`);
            }
        }
        console.log('===========================\n');

        this.lastUpdate = Date.now();
        this.isUpdating = false;
        console.log('Aggiornamento EPG completato con successo');
    }

    getCurrentProgram(channelId) {
        console.log('[EPG] Ricerca programma corrente per ID:', channelId);
        
        // Cerca corrispondenze simili per debug
        const similarMatches = [];
        const searchTerm = channelId.toLowerCase();
        
        for (const [id, programs] of this.programGuide.entries()) {
            // Verifica diverse possibili somiglianze
            const idLower = id.toLowerCase();
            const similarity = {
                id: id,
                matchType: null,
                programCount: programs.length,
                sample: programs[0] ? {
                    title: programs[0].title,
                    start: programs[0].start,
                    stop: programs[0].stop
                } : 'Nessun programma'
            };

            if (idLower.includes(searchTerm) || searchTerm.includes(idLower)) {
                similarity.matchType = 'partial';
                similarMatches.push(similarity);
            } else if (idLower === searchTerm) {  // Match case-insensitive esatto
                similarity.matchType = 'exact-case-insensitive';
                similarMatches.push(similarity);
            }
        }

        // Logga le corrispondenze simili trovate
        if (similarMatches.length > 0) {
            console.log('[EPG] Trovate corrispondenze simili:', 
                similarMatches.map(m => 
                    `\n- ID: "${m.id}" (${m.matchType})`
                    + `\n  Programmi totali: ${m.programCount}`
                    + `\n  Esempio: ${typeof m.sample === 'string' ? m.sample : JSON.stringify(m.sample)}`
                ).join('')
            );
        }

        // Debug info sulla ricerca esatta
        const programs = this.programGuide.get(channelId);
        console.log(`[EPG] Dati per match esatto "${channelId}":`,
            programs ? `${programs.length} programmi trovati` : 'Nessun programma');
        
        if (!programs || programs.length === 0) {
            console.log('[EPG] Nessun programma trovato per ID esatto:', channelId);
            return null;
        }

        // Trova il programma corrente
        const now = new Date();
        const nowUTC = new Date(now.toISOString());
        const validPrograms = programs.filter(p => 
            p.start && p.stop && !isNaN(p.start) && !isNaN(p.stop)
        );
        
        console.log(`[EPG] Programmi validi per ${channelId}: ${validPrograms.length}/${programs.length}`);
        
        const currentProgram = validPrograms.find(program => 
            program.start <= nowUTC && program.stop >= nowUTC
        );

        if (currentProgram) {
            console.log('[EPG] Programma corrente trovato:', JSON.stringify(currentProgram, null, 2));
            return currentProgram;
        }

        console.log('[EPG] Nessun programma corrente per ID:', channelId, 
            '(Primo programma disponibile:', JSON.stringify(programs[0], null, 2), ')');
        return null;
    }

    getUpcomingPrograms(channelId, limit = 5) {
        console.log('[EPG] Ricerca programmi futuri per ID:', channelId);
        
        // Debug info sulla ricerca esatta
        const programs = this.programGuide.get(channelId);
        console.log(`[EPG] Dati per match esatto "${channelId}":`,
            programs ? `${programs.length} programmi trovati` : 'Nessun programma');
        
        if (!programs || programs.length === 0) {
            console.log('[EPG] Nessun programma trovato per ID:', channelId);
            return [];
        }

        // Filtra i programmi futuri
        const now = new Date();
        const validPrograms = programs.filter(p => 
            p.start && p.stop && !isNaN(p.start) && !isNaN(p.stop)
        );
        
        console.log(`[EPG] Programmi validi per ${channelId}: ${validPrograms.length}/${programs.length}`);
        
        const upcomingPrograms = validPrograms
            .filter(program => program.start >= now)
            .slice(0, limit);

        if (upcomingPrograms.length > 0) {
            console.log('[EPG] Programmi futuri trovati:', JSON.stringify(upcomingPrograms, null, 2));
            return upcomingPrograms;
        }

        console.log('[EPG] Nessun programma futuro per ID:', channelId);
        return [];
    }

    needsUpdate() {
        if (!this.lastUpdate) return true;
        // Controlla se sono passate più di 24 ore dall'ultimo aggiornamento
        const hoursSinceUpdate = (Date.now() - this.lastUpdate) / (1000 * 60 * 60);
        return hoursSinceUpdate >= 24;
    }

    isEPGAvailable() {
        return this.programGuide.size > 0 && !this.isUpdating;
    }

    getStatus() {
        return {
            isUpdating: this.isUpdating,
            lastUpdate: this.lastUpdate ? new Date(this.lastUpdate).toLocaleString() : 'Mai',
            channelsCount: this.programGuide.size,
            programsCount: Array.from(this.programGuide.values()).reduce((acc, progs) => acc + progs.length, 0)
        };
    }
}

module.exports = new EPGManager();
