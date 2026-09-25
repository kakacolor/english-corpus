import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from './src/auth/AuthContext';
import LoginScreen from './src/screens/LoginScreen';
import MainTabs from './src/navigation/MainTabs';

const Stack = createNativeStackNavigator();

function Root() {
  const { token, bootstrapped } = useAuth();
  if (!bootstrapped) return null; // 正在读本地登录态
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {token ? (
          <Stack.Screen name="Main" component={MainTabs} />
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <StatusBar style="auto" />
      <Root />
    </AuthProvider>
  );
}