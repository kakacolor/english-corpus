import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import WordbookScreen from '../screens/WordbookScreen';
import CameraScreen from '../screens/CameraScreen';
import ReviewScreen from '../screens/ReviewScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();

const TAB_ICONS = {
  '单词本': '📖',
  '拍照识词': '📷',
  '背单词': '🧠',
  '设置': '⚙️',
};

export default function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: true,
        tabBarActiveTintColor: '#2563eb',
        tabBarIcon: ({ color, size }) => (
          <Text style={{ fontSize: size, color }}>{TAB_ICONS[route.name] || '•'}</Text>
        ),
      })}
    >
      <Tab.Screen name="单词本" component={WordbookScreen} />
      <Tab.Screen name="拍照识词" component={CameraScreen} />
      <Tab.Screen name="背单词" component={ReviewScreen} />
      {/* 「同步」已并入设置页 → 数据 选项卡（SettingsScreen 的 data tab），不再单独占一个底部 Tab */}
      <Tab.Screen name="设置" component={SettingsScreen} />
    </Tab.Navigator>
  );
}