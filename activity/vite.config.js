
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '../', '');

    return {
        plugins: [react()],

        envDir: '../',

        define: {
            'import.meta.env.VITE_DISCORD_CLIENT_ID': JSON.stringify(
                env.CLIENT_ID
            )
        },

        server: {
            host: '127.0.0.1',

            allowedHosts: [
                env.ACTIVITY_ALLOWED_HOST
            ],

            proxy: {
                '/api': {
                    target: 'http://localhost:3001',
                    changeOrigin: true
                },
                '/ws': {
                    target: 'ws://localhost:3001',
                    ws: true
                }
            }
        }
    };
});
