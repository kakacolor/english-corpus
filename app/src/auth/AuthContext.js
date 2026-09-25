import React, { createContext, useContext, useEffect, useState } from 'react';
import { loadServerUrl } from '../api';
import { login, register, logout, fetchMe, loadAuthToken, setAuthToken } from './authApi';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // 先恢复 App 内自定义的服务器地址（手机 App 设置页保存的），再做登录态恢复
        await loadServerUrl();
        const t = await loadAuthToken();
        if (t) {
          setAuthToken(t);
          setToken(t);
          try {
            const u = await fetchMe();
            setUser(u);
          } catch (e) {
            // token 失效，清空
            setToken(null);
            setUser(null);
          }
        }
      } finally {
        setBootstrapped(true);
      }
    })();
  }, []);

  const value = {
    token,
    user,
    bootstrapped,
    async signIn(account, password) {
      const data = await login(account, password);
      setToken(data.token);
      setUser(data.user);
      return data;
    },
    async signUp(username, email, password) {
      const data = await register(username, email, password);
      setToken(data.token);
      setUser(data.user);
      return data;
    },
    async signOut() {
      logout();
      setToken(null);
      setUser(null);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}