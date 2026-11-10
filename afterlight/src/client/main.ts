import './ui/styles.css';
import { App } from './app';

const app = new App(document.getElementById('view')!, document.getElementById('ui')!);
void app.boot();
